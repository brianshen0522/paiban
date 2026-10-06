import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { GeoTable, ipv6ToBigInt, loadGeoTable } from './geoip.js';

/** A few rows in DB-IP's format (first,last,CC), made up for the test. */
const ROWS: [string, string, string][] = [
  ['1.0.0.0', '1.0.0.255', 'AU'],
  ['8.8.8.0', '8.8.8.255', 'US'],
  ['61.220.0.0', '61.231.255.255', 'TW'],
  ['10.0.0.0', '10.255.255.255', 'ZZ'],
  ['2001:200::', '2001:200:ffff:ffff:ffff:ffff:ffff:ffff', 'JP'],
  ['2a00:1450::', '2a00:1450:ffff:ffff:ffff:ffff:ffff:ffff', 'IE'],
];

describe('IP to country', () => {
  const geo = new GeoTable(ROWS);

  it('finds IPv4 addresses inside a range, and nothing outside', () => {
    expect(geo.country('61.224.10.3')).toBe('TW');
    expect(geo.country('8.8.8.8')).toBe('US');
    expect(geo.country('8.8.9.1')).toBeNull();
    expect(geo.country('1.0.0.0')).toBe('AU');
    expect(geo.country('1.0.0.255')).toBe('AU');
  });

  it('reads IPv6, compressed forms and IPv4-mapped addresses', () => {
    expect(geo.country('2001:200:1::5')).toBe('JP');
    expect(geo.country('2a00:1450:4009:81e::200e')).toBe('IE');
    expect(geo.country('::ffff:61.220.1.1')).toBe('TW');
    expect(geo.country('2001:201::1')).toBeNull();
    expect(ipv6ToBigInt('::1')).toBe(1n);
    expect(ipv6ToBigInt('::ffff:1.2.3.4')).toBe(0xffff01020304n);
  });

  it('knows no country for ZZ rows or nonsense', () => {
    expect(geo.country('10.1.2.3')).toBeNull();
    expect(geo.country('not an address')).toBeNull();
    expect(geo.size).toBe(5);
  });

  it('loads plain and gzipped CSV, and an empty table when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'geo-'));
    const csv = `${ROWS.map((r) => r.join(',')).join('\n')}\n`;
    await writeFile(join(dir, 'a.csv'), csv);
    await writeFile(join(dir, 'a.csv.gz'), gzipSync(csv));
    expect((await loadGeoTable(join(dir, 'a.csv'))).country('8.8.8.8')).toBe('US');
    expect((await loadGeoTable(join(dir, 'a.csv.gz'))).country('2001:200::9')).toBe('JP');
    expect((await loadGeoTable(join(dir, 'missing.csv'))).size).toBe(0);
    expect((await loadGeoTable(undefined)).size).toBe(0);
  });
});
