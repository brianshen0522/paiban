import { describe, expect, it } from 'vitest';
import { GeoTable } from '../geo/geoip.js';
import type { EngineSnapshot } from './engine.js';
import { buildLive, homeCountry, maskAddress } from './live.js';
import { clientName } from './peer-client.js';

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex');

describe('peer clients', () => {
  it('prefers the name the peer sends, and decodes Azureus-style peer ids otherwise', () => {
    expect(clientName(null, 'qBittorrent/4.6.3')).toBe('qBittorrent/4.6.3');
    expect(clientName(hex('-qB4630-abcdefghijkl'), null)).toBe('qBittorrent 4.6.3');
    expect(clientName(hex('-TR4050-abcdefghijkl'), null)).toBe('Transmission 4.0.5');
    expect(clientName(hex('-WW0201-abcdefghijkl'), null)).toBe('WebTorrent 2.1');
    expect(clientName(hex('M7-2-2--abcdefghijkl'), null)).toBeNull();
    expect(clientName(null, '<script>x</script>')).toBe('scriptx/script');
  });
});

describe('the live view', () => {
  it('hides most of an address', () => {
    expect(maskAddress('61.220.33.4')).toBe('61.220.x.x');
    expect(maskAddress('::ffff:61.220.33.4')).toBe('61.220.x.x');
    expect(maskAddress('2001:db8:1:2::5')).toBe('2001:db8:x');
  });

  it('places this server by its time zone, Taiwan when unknown', () => {
    expect(homeCountry('Asia/Tokyo')).toBe('JP');
    expect(homeCountry('Mars/Olympus')).toBe('TW');
    expect(homeCountry(undefined)).toBe('TW');
  });

  it('builds peers with countries, directions and shares, busiest first, no full addresses', () => {
    const geo = new GeoTable([['61.220.0.0', '61.231.255.255', 'TW']]);
    const snap: EngineSnapshot = {
      pieceCount: 10,
      pieceLength: 16384,
      have: Buffer.from([0b11100000, 0]),
      active: Buffer.from([0b00010000, 0]),
      availability: Uint8Array.from([2, 2, 2, 1, 1, 0, 0, 0, 0, 0]),
      peers: [
        {
          address: '192.168.1.9',
          port: 6881,
          type: 'tcpIncoming',
          peerId: null,
          clientVersion: null,
          downBps: 10,
          upBps: 0,
          pieces: 2,
        },
        {
          address: '61.224.1.2',
          port: 51413,
          type: 'utpOutgoing',
          peerId: hex('-TR4050-abcdefghijkl'),
          clientVersion: null,
          downBps: 900,
          upBps: 50,
          pieces: 5,
        },
      ],
    };
    const live = buildLive(snap, { downBps: 910.4, upBps: 50 }, [{ downBps: 1, upBps: 2 }], geo, 'TW');
    expect(live.peers.map((p) => [p.address, p.country, p.local, p.direction, p.transport, p.has, p.client])).toEqual([
      ['61.224.x.x', 'TW', false, 'out', 'utp', 0.5, 'Transmission 4.0.5'],
      ['192.168.x.x', null, true, 'in', 'tcp', 0.2, null],
    ]);
    expect(live.pieces).toEqual({
      count: 10,
      size: 16384,
      have: Buffer.from([0b11100000, 0]).toString('base64'),
      active: Buffer.from([0b00010000, 0]).toString('base64'),
      availability: Buffer.from([2, 2, 2, 1, 1, 0, 0, 0, 0, 0]).toString('base64'),
    });
    expect(live.downBps).toBe(910);
    expect(JSON.stringify(live)).not.toContain('61.224.1.2');
  });

  it('has no pieces before the metadata arrived', () => {
    expect(buildLive(null, { downBps: 0, upBps: 0 }, [], new GeoTable([]), 'TW')).toMatchObject({
      pieces: null,
      peers: [],
    });
  });
});
