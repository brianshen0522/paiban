import { APP_VERSION, SITE_NAME_ASCII } from '@paiban/shared';
import { isInternalAddress, resolveHost } from './address.js';

/**
 * The one HTTP client for talking to the outside (docs/12-auth.md, "對外請求"): host allow-list,
 * no internal addresses (checked after DNS), https only, at most 3 redirects each checked again,
 * timeout, size cap read as the body arrives, and logs without query strings. YTS uses it now; the
 * subtitle sources reuse it in phase 5.
 */
export type OutboundErrorKind = 'BLOCKED' | 'REDIRECTED' | 'TIMEOUT' | 'NETWORK' | 'TOO_LARGE' | 'TOO_MANY_REDIRECTS';

export class OutboundError extends Error {
  readonly kind: OutboundErrorKind;
  /** For REDIRECTED: the host the request was sent to. */
  readonly host: string | undefined;
  constructor(kind: OutboundErrorKind, message: string, host?: string) {
    super(message);
    this.kind = kind;
    this.host = host;
  }
}

export type OutboundPolicy = {
  /** Development and tests: allow http:// and internal addresses. */
  allowLocal: boolean;
  /** Development and tests: fixed host → replacement base URL, applied after the allow-list check. */
  overrides: Record<string, string>;
  log?: (entry: { host: string; path: string; status?: number; ms: number; error?: string }) => void;
  resolve?: (host: string) => Promise<string[]>;
};

export type OutboundRequest = {
  /** Whether a host may be contacted at all. Checked for the first URL and after every redirect. */
  allow: (host: string) => boolean;
  timeoutMs?: number;
  maxBytes: number;
  /** A redirect to another host is an error (YTS) instead of being followed (subtitle downloads). */
  sameHostRedirectsOnly?: boolean;
  headers?: Record<string, string>;
};

export type OutboundResponse = { status: number; headers: Headers; body: Buffer; url: string };

export const USER_AGENT = `${SITE_NAME_ASCII}/${APP_VERSION}`;

function bare(u: URL): string {
  return `${u.host}${u.pathname}`;
}

export async function outboundFetch(
  policy: OutboundPolicy,
  url: string,
  req: OutboundRequest,
): Promise<OutboundResponse> {
  const started = Date.now();
  let current = new URL(url);
  const firstHost = current.host;
  for (let hop = 0; hop <= 3; hop++) {
    await checkTarget(policy, current, req);
    const target = applyOverride(policy, current);
    let res: Response;
    try {
      res = await fetch(target, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, ...req.headers },
        signal: AbortSignal.timeout(req.timeoutMs ?? 10_000),
      });
    } catch (err) {
      const timeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      policy.log?.({
        host: current.host,
        path: current.pathname,
        ms: Date.now() - started,
        error: timeout ? 'timeout' : 'network',
      });
      throw new OutboundError(
        timeout ? 'TIMEOUT' : 'NETWORK',
        `${bare(current)}: ${timeout ? 'timed out' : 'network error'}`,
      );
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel();
      const next = new URL(res.headers.get('location') as string, current);
      policy.log?.({ host: current.host, path: current.pathname, status: res.status, ms: Date.now() - started });
      if (req.sameHostRedirectsOnly && next.host !== firstHost) {
        throw new OutboundError('REDIRECTED', `${bare(current)} redirects to ${next.host}`, next.host);
      }
      current = next;
      continue;
    }
    const body = await readCapped(res, req.maxBytes, current);
    policy.log?.({ host: current.host, path: current.pathname, status: res.status, ms: Date.now() - started });
    return { status: res.status, headers: res.headers, body, url: current.toString() };
  }
  throw new OutboundError('TOO_MANY_REDIRECTS', `${bare(new URL(url))}: more than 3 redirects`);
}

async function checkTarget(policy: OutboundPolicy, u: URL, req: OutboundRequest): Promise<void> {
  if (u.protocol !== 'https:' && !(policy.allowLocal && u.protocol === 'http:')) {
    throw new OutboundError('BLOCKED', `${bare(u)}: only https is allowed`);
  }
  if (!req.allow(u.hostname)) throw new OutboundError('BLOCKED', `${bare(u)}: host not on the allow-list`);
  if (policy.allowLocal) return;
  let addresses: string[];
  try {
    addresses = await (policy.resolve ?? resolveHost)(u.hostname.replace(/^\[|\]$/g, ''));
  } catch {
    throw new OutboundError('NETWORK', `${bare(u)}: name does not resolve`);
  }
  if (addresses.length === 0 || addresses.some(isInternalAddress)) {
    throw new OutboundError('BLOCKED', `${bare(u)}: resolves to an internal address`);
  }
}

function applyOverride(policy: OutboundPolicy, u: URL): string {
  const base = policy.allowLocal ? policy.overrides[u.host] : undefined;
  if (!base) return u.toString();
  return `${base.replace(/\/+$/, '')}${u.pathname}${u.search}`;
}

async function readCapped(res: Response, maxBytes: number, u: URL): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new OutboundError('TOO_LARGE', `${bare(u)}: ${declared} bytes is over the ${maxBytes} limit`);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new OutboundError('TOO_LARGE', `${bare(u)}: response over the ${maxBytes} byte limit`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
