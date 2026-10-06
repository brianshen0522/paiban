import { createReadStream } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/**
 * Which country an IP address is in, for the peer map on the download page (docs/11-pages.md,
 * "下載細節"). The table is DB-IP's free "IP to Country Lite" (CC BY 4.0: the map credits
 * DB-IP.com), downloaded when the image is built, so a lookup never leaves the machine. Rows are
 * `first,last,CC`; DB-IP writes `ZZ` for addresses that belong to no country.
 */
export type CountryLookup = { country(ip: string): string | null; readonly size: number };

export function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return (((p[0] ?? 0) << 24) >>> 0) + ((p[1] ?? 0) << 16) + ((p[2] ?? 0) << 8) + (p[3] ?? 0);
}

export function ipv6ToBigInt(ip: string): bigint {
  let addr = ip;
  // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4?.[1]) {
    const n = ipv4ToInt(v4[1]);
    addr = `${addr.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = addr.split('::');
  const h = head ? head.split(':') : [];
  const tl = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(8 - h.length - tl.length).fill('0'), ...tl] : h;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(Number.parseInt(g || '0', 16)), 0n);
}

/** `::ffff:1.2.3.4` and other IPv4-mapped forms, as plain IPv4. */
function unmap(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m?.[1] ?? ip;
}

function search<T extends number | bigint>(starts: ArrayLike<T>, value: T): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] as T) <= value) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export class GeoTable implements CountryLookup {
  private readonly v4Start: Uint32Array;
  private readonly v4End: Uint32Array;
  private readonly v4Cc: string[];
  private readonly v6Start: bigint[];
  private readonly v6End: bigint[];
  private readonly v6Cc: string[];

  constructor(rows: Iterable<[string, string, string]>) {
    const v4: [number, number, string][] = [];
    const v6: [bigint, bigint, string][] = [];
    for (const [a, b, cc] of rows) {
      if (cc === 'ZZ' || !/^[A-Z]{2}$/.test(cc)) continue;
      if (isIPv4(a) && isIPv4(b)) v4.push([ipv4ToInt(a), ipv4ToInt(b), cc]);
      else if (isIPv6(a) && isIPv6(b)) v6.push([ipv6ToBigInt(a), ipv6ToBigInt(b), cc]);
    }
    v4.sort((x, y) => x[0] - y[0]);
    v6.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
    this.v4Start = Uint32Array.from(v4, (r) => r[0]);
    this.v4End = Uint32Array.from(v4, (r) => r[1]);
    this.v4Cc = v4.map((r) => r[2]);
    this.v6Start = v6.map((r) => r[0]);
    this.v6End = v6.map((r) => r[1]);
    this.v6Cc = v6.map((r) => r[2]);
  }

  get size(): number {
    return this.v4Cc.length + this.v6Cc.length;
  }

  country(raw: string): string | null {
    const ip = unmap(raw.trim());
    if (isIPv4(ip)) {
      const n = ipv4ToInt(ip);
      const i = search(this.v4Start, n);
      return i >= 0 && n <= (this.v4End[i] ?? 0) ? (this.v4Cc[i] ?? null) : null;
    }
    if (isIPv6(ip)) {
      const n = ipv6ToBigInt(ip);
      const i = search(this.v6Start, n);
      return i >= 0 && n <= (this.v6End[i] ?? 0n) ? (this.v6Cc[i] ?? null) : null;
    }
    return null;
  }
}

/** The table at `path` (plain or .gz CSV). A missing or unreadable file gives a table that knows nothing. */
export async function loadGeoTable(path: string | undefined): Promise<GeoTable> {
  const rows: [string, string, string][] = [];
  if (path) {
    try {
      const input = createReadStream(path);
      const stream = path.endsWith('.gz') ? input.pipe(createGunzip()) : input;
      for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
        const [a, b, cc] = line.split(',');
        if (a && b && cc) rows.push([a.trim(), b.trim(), cc.trim().replace(/"/g, '')]);
      }
    } catch {
      return new GeoTable([]);
    }
  }
  return new GeoTable(rows);
}
