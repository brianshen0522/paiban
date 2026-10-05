import type { DetectedLang, Lang, SourceCheck } from '@paiban/shared';
import type { Logger } from 'pino';
import type { Pool, Queryable } from '../../db/pool.js';
import { one } from '../../db/pool.js';
import { OutboundError, type OutboundPolicy, type OutboundResponse, outboundFetch } from '../../net/outbound.js';

/**
 * What every subtitle source shares (docs/07-subtitle-providers.md, "共通規則"): the shared
 * outbound client with a per-source host list, request pacing through provider_take_slot, the
 * time and size limits, and failures as codes. Sources never see the database beyond pacing and
 * the film; keys come in through `secret`.
 */

export type ProviderKey = 'justsubtitles' | 'yify' | 'assrt';

export type FilmContext = {
  imdbCode: string;
  tmdbId: number | null;
  title: string;
  titleZh: string | null;
  year: number;
  release: { quality: string; source: string; videoCodec: string };
};

export type FoundSubtitle = {
  /** Stable id inside the source; never carries a query string. */
  ref: string;
  languageLabel: string;
  language: DetectedLang;
  releaseName: string;
  uploader: string | null;
  pageUrl: string | null;
  hearingImpaired: boolean;
  rating: number | null;
  /** Where the file is when that needs no request to find out; stored without a query string. */
  downloadUrl: string | null;
  ass: boolean;
};

export type Download = { url: string; fileName: string };

/** A source answered in a way that ends this search or download (ProviderStatus.error.code). */
export type ProviderErrorCode = 'RATE_LIMITED' | 'UNREACHABLE' | 'BAD_RESPONSE' | 'NOT_CONFIGURED';

export class ProviderFailure extends Error {
  readonly code: ProviderErrorCode;
  readonly retryAt: Date | null;
  /** For a source test: the key was refused (not reported as a search state, docs/07). */
  readonly invalidKey: boolean;
  constructor(code: ProviderErrorCode, message: string, opts: { retryAt?: Date | null; invalidKey?: boolean } = {}) {
    super(message);
    this.code = code;
    this.retryAt = opts.retryAt ?? null;
    this.invalidKey = opts.invalidKey ?? false;
  }
}

/** The file behind one search result cannot be had (DOWNLOAD_FAILED); `layout` marks a page that changed. */
export class DownloadFailure extends Error {
  readonly layout: boolean;
  constructor(message: string, layout = false) {
    super(message);
    this.layout = layout;
  }
}

export type ProviderEnv = {
  pool: Pool;
  outbound: OutboundPolicy;
  log: Logger;
  secret: (name: 'tmdbKey' | 'subdlKey' | 'assrtToken') => Promise<string | null>;
  /** Waits; tests may shorten it. */
  sleep?: (ms: number) => Promise<void>;
};

export interface SubtitleProvider {
  id: ProviderKey;
  /** Hosts this source may contact (exact names or `.suffix`). */
  allow(host: string): boolean;
  search(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]>;
  /** Download addresses that are good now; some sources hand out temporary ones, so this runs right before downloading. */
  resolveDownload(found: { ref: string; downloadUrl: string | null }): Promise<Download[]>;
}

export const JSON_MAX = 2 * 1024 * 1024;
export const FILE_MAX = 20 * 1024 * 1024;
export const PACING_MS: Record<ProviderKey, number> = { justsubtitles: 1000, yify: 1000, assrt: 3400 };

export function hostList(...names: string[]): (host: string) => boolean {
  return (host) => names.some((n) => (n.startsWith('.') ? host.endsWith(n) || host === n.slice(1) : host === n));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** provider_take_slot: wait for our turn at this source, whichever process asks (D41). */
export async function takeSlot(env: ProviderEnv, key: ProviderKey): Promise<void> {
  const r = await one<{ at: Date }>(env.pool, 'select provider_take_slot($1, $2) as at', [key, PACING_MS[key]]);
  const wait = (r?.at.getTime() ?? 0) - Date.now();
  if (wait > 0) await (env.sleep ?? defaultSleep)(wait);
}

/** 30900 from 射手網: nobody sends to it for the next 60 s (docs/07, "限制"). */
export async function holdSource(q: Queryable, key: ProviderKey, seconds: number): Promise<Date> {
  const r = await one<{ at: Date }>(
    q,
    `insert into provider_slots (provider, next_at) values ($1, clock_timestamp() + make_interval(secs => $2))
     on conflict (provider) do update set next_at = greatest(provider_slots.next_at, excluded.next_at) returning next_at as at`,
    [key, seconds],
  );
  return r?.at ?? new Date(Date.now() + seconds * 1000);
}

/**
 * One request through the shared client. Pacing first when `pace` names the source. Transport
 * problems become UNREACHABLE; an answer over the size cap becomes BAD_RESPONSE.
 */
export async function request(
  env: ProviderEnv,
  url: string,
  opts: {
    allow: (host: string) => boolean;
    pace?: ProviderKey;
    maxBytes?: number;
    timeoutMs?: number;
    headers?: Record<string, string>;
  },
): Promise<OutboundResponse> {
  if (opts.pace) await takeSlot(env, opts.pace);
  try {
    return await outboundFetch(env.outbound, url, {
      allow: opts.allow,
      maxBytes: opts.maxBytes ?? JSON_MAX,
      timeoutMs: opts.timeoutMs ?? 10_000,
      ...(opts.headers ? { headers: opts.headers } : {}),
    });
  } catch (err) {
    if (err instanceof OutboundError) {
      throw new ProviderFailure(err.kind === 'TOO_LARGE' ? 'BAD_RESPONSE' : 'UNREACHABLE', err.message);
    }
    throw err;
  }
}

export function asJson(res: OutboundResponse): unknown {
  const type = res.headers.get('content-type') ?? '';
  const text = res.body.toString('utf8');
  if (!/json/i.test(type) && !/^\s*[[{]/.test(text)) throw new ProviderFailure('BAD_RESPONSE', 'not JSON');
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderFailure('BAD_RESPONSE', 'not JSON');
  }
}

/** Only the path of a URL from a response: someone else's key in the query string goes here (D28). */
export function pathOnly(raw: string): string {
  try {
    return new URL(raw, 'https://x.invalid').pathname;
  } catch {
    return '';
  }
}

/** Which of our guesses a search for these languages takes (docs/07, "語言"). Traditional takes every Chinese. */
export function wanted(languages: readonly Lang[], guess: DetectedLang): boolean {
  if (guess === 'en') return languages.includes('en');
  if (guess === 'zh-Hant') return languages.includes('zh-Hant');
  if (guess === 'zh-Hans' || guess === 'zh') return languages.includes('zh-Hant') || languages.includes('zh-Hans');
  return false;
}

/** The source test's answer and its timing (docs/13-settings.md, "測試連線"). */
export function check(
  started: number,
  ok: boolean,
  code: SourceCheck['code'],
  data: Record<string, string | number> = {},
): SourceCheck {
  return { ok, code, data, ms: Date.now() - started };
}

export function failureCheck(started: number, err: unknown): SourceCheck {
  if (err instanceof ProviderFailure) {
    if (err.invalidKey) return check(started, false, 'INVALID_KEY');
    if (err.code === 'RATE_LIMITED')
      return check(
        started,
        false,
        'RATE_LIMITED',
        err.retryAt ? { retryAfterSeconds: Math.max(0, Math.round((err.retryAt.getTime() - Date.now()) / 1000)) } : {},
      );
    return check(started, false, err.code);
  }
  throw err;
}
