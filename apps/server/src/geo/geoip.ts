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

const packCc = (cc: string) => (cc.charCodeAt(0) << 8) | cc.charCodeAt(1);
const unpackCc = (n: number) => String.fromCharCode(n >> 8, n & 0xff);
/** IPv6 ranges are kept by their first 64 bits: no country owns less than a /64. */
const high64 = (ip: string) => ipv6ToBigInt(ip) >> 64n;

/**
 * Sorted ranges in typed arrays (about 700,000 rows in DB-IP's table): a few tens of megabytes,
 * where plain objects and strings took half a gigabyte.
 */
export class GeoTable implements CountryLookup {
  private v4Start: Uint32Array = new Uint32Array(0);
  private v4End: Uint32Array = new Uint32Array(0);
  private v4Cc: Uint16Array = new Uint16Array(0);
  private v6Start: BigUint64Array = new BigUint64Array(0);
  private v6End: BigUint64Array = new BigUint64Array(0);
  private v6Cc: Uint16Array = new Uint16Array(0);

  constructor(rows: Iterable<[string, string, string]> = []) {
    const b = new GeoBuilder();
    for (const [a, z, cc] of rows) b.add(a, z, cc);
    b.finishInto(this);
  }

  /** @internal Used by GeoBuilder. */
  set(v4: [Uint32Array, Uint32Array, Uint16Array], v6: [BigUint64Array, BigUint64Array, Uint16Array]): void {
    [this.v4Start, this.v4End, this.v4Cc] = v4;
    [this.v6Start, this.v6End, this.v6Cc] = v6;
  }

  get size(): number {
    return this.v4Cc.length + this.v6Cc.length;
  }

  country(raw: string): string | null {
    const ip = unmap(raw.trim());
    if (isIPv4(ip)) {
      const n = ipv4ToInt(ip);
      const i = search(this.v4Start, n);
      return i >= 0 && n <= (this.v4End[i] ?? 0) ? unpackCc(this.v4Cc[i] ?? 0) : null;
    }
    if (isIPv6(ip)) {
      const n = high64(ip);
      const i = search(this.v6Start, n);
      return i >= 0 && n <= (this.v6End[i] ?? 0n) ? unpackCc(this.v6Cc[i] ?? 0) : null;
    }
    return null;
  }
}

/** Collects rows into growing typed arrays, then sorts them once. */
class GeoBuilder {
  private v4 = { s: new Uint32Array(1 << 16), e: new Uint32Array(1 << 16), c: new Uint16Array(1 << 16), n: 0 };
  private v6 = { s: new BigUint64Array(1 << 16), e: new BigUint64Array(1 << 16), c: new Uint16Array(1 << 16), n: 0 };

  add(a: string, z: string, cc: string): void {
    if (cc === 'ZZ' || !/^[A-Z]{2}$/.test(cc)) return;
    if (isIPv4(a) && isIPv4(z)) {
      const t = this.v4;
      if (t.n === t.s.length) this.v4 = { s: grow(t.s), e: grow(t.e), c: grow(t.c), n: t.n };
      this.v4.s[this.v4.n] = ipv4ToInt(a);
      this.v4.e[this.v4.n] = ipv4ToInt(z);
      this.v4.c[this.v4.n++] = packCc(cc);
    } else if (isIPv6(a) && isIPv6(z)) {
      const t = this.v6;
      if (t.n === t.s.length) this.v6 = { s: grow(t.s), e: grow(t.e), c: grow(t.c), n: t.n };
      this.v6.s[this.v6.n] = high64(a);
      this.v6.e[this.v6.n] = high64(z);
      this.v6.c[this.v6.n++] = packCc(cc);
    }
  }

  finishInto(table: GeoTable): void {
    const order4 = sortedOrder(this.v4.n, (i) => this.v4.s[i] ?? 0);
    const order6 = sortedOrder(this.v6.n, (i) => this.v6.s[i] ?? 0n);
    table.set(
      [
        Uint32Array.from(order4, (i) => this.v4.s[i] ?? 0),
        Uint32Array.from(order4, (i) => this.v4.e[i] ?? 0),
        Uint16Array.from(order4, (i) => this.v4.c[i] ?? 0),
      ],
      [
        BigUint64Array.from(order6, (i) => this.v6.s[i] ?? 0n),
        BigUint64Array.from(order6, (i) => this.v6.e[i] ?? 0n),
        Uint16Array.from(order6, (i) => this.v6.c[i] ?? 0),
      ],
    );
  }
}

function grow<T extends Uint32Array | Uint16Array | BigUint64Array>(a: T): T {
  const next = new (a.constructor as new (n: number) => T)(a.length * 2);
  (next as unknown as { set(x: T): void }).set(a);
  return next;
}

/** Row indexes in order of start; DB-IP's file is already sorted, so this is mostly a check. */
function sortedOrder<V extends number | bigint>(n: number, key: (i: number) => V): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  let sorted = true;
  for (let i = 1; i < n && sorted; i++) if (key(i) < key(i - 1)) sorted = false;
  if (!sorted) idx.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  return idx;
}

/** The table at `path` (plain or .gz CSV). A missing or unreadable file gives a table that knows nothing. */
export async function loadGeoTable(path: string | undefined): Promise<GeoTable> {
  const table = new GeoTable();
  if (!path) return table;
  const b = new GeoBuilder();
  try {
    const input = createReadStream(path);
    const stream = path.endsWith('.gz') ? input.pipe(createGunzip()) : input;
    for await (const line of createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })) {
      const i = line.indexOf(',');
      const j = line.indexOf(',', i + 1);
      if (i < 0 || j < 0) continue;
      b.add(
        line.slice(0, i),
        line.slice(i + 1, j),
        line
          .slice(j + 1)
          .trim()
          .replace(/"/g, ''),
      );
    }
  } catch {
    return table;
  }
  b.finishInto(table);
  return table;
}
