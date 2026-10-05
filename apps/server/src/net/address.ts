import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * Internal addresses the server must never be pointed at (docs/12-auth.md, "對外請求"). Spelled out
 * with Node's own BlockList; the npm `ip` package is avoided on purpose (GHSA-2p57-rm9w-gvfp).
 */
const internal = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  internal.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
] as const) {
  internal.addSubnet(net, prefix, 'ipv6');
}

export function isInternalAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return internal.check(address, 'ipv4');
  if (family === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    if (mapped?.[1]) return internal.check(mapped[1], 'ipv4');
    return internal.check(address, 'ipv6');
  }
  return true; // not an address at all: refuse
}

export async function resolveHost(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((a) => a.address);
}

/**
 * Checks a source base URL an administrator typed (YTS, YIFY Subtitles). Returns a code for the
 * field when it is not acceptable: URL_FORMAT (not https://host[:port] without a path) or INTERNAL.
 * With `allowLocal` (development and tests) http:// and internal addresses pass.
 */
export async function checkSourceUrl(
  value: string,
  opts: { allowLocal: boolean; resolveHost?: (host: string) => Promise<string[]> },
): Promise<'URL_FORMAT' | 'INTERNAL' | null> {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return 'URL_FORMAT';
  }
  const protocolOk = u.protocol === 'https:' || (opts.allowLocal && u.protocol === 'http:');
  if (!protocolOk || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    return 'URL_FORMAT';
  }
  if (!/^https?:\/\/[^/]+\/?$/i.test(value)) return 'URL_FORMAT';
  if (opts.allowLocal) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local'))
    return 'INTERNAL';
  let addresses: string[];
  try {
    addresses = await (opts.resolveHost ?? resolveHost)(host);
  } catch {
    return null; // a name that does not resolve now is not internal; the connection test will say it is unreachable
  }
  return addresses.some(isInternalAddress) ? 'INTERNAL' : null;
}
