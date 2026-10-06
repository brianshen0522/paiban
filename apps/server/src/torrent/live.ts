import { createHash, randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import type { TorrentLive, TorrentLivePeer } from '@paiban/shared';
import type { CountryLookup } from '../geo/geoip.js';
import { isInternalAddress } from '../net/address.js';
import type { EngineSnapshot } from './engine.js';
import { clientName } from './peer-client.js';

/** Speed points kept per download: one per loop pass (2 s), two minutes. */
export const HISTORY_POINTS = 60;

/**
 * Time zones people are likely to run this in, to the country the map draws its lines to. The
 * server never asks anyone where it is; an unknown zone falls back to Taiwan (D-level default:
 * the project's home).
 */
const ZONES: Record<string, string> = {
  'Asia/Taipei': 'TW',
  'Asia/Hong_Kong': 'HK',
  'Asia/Macau': 'MO',
  'Asia/Shanghai': 'CN',
  'Asia/Chongqing': 'CN',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Manila': 'PH',
  'Asia/Jakarta': 'ID',
  'Asia/Kolkata': 'IN',
  'Asia/Dubai': 'AE',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Pacific/Auckland': 'NZ',
  'Europe/London': 'GB',
  'Europe/Dublin': 'IE',
  'Europe/Paris': 'FR',
  'Europe/Berlin': 'DE',
  'Europe/Amsterdam': 'NL',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Stockholm': 'SE',
  'Europe/Zurich': 'CH',
  'Europe/Moscow': 'RU',
  'America/New_York': 'US',
  'America/Chicago': 'US',
  'America/Denver': 'US',
  'America/Los_Angeles': 'US',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Mexico_City': 'MX',
  'America/Sao_Paulo': 'BR',
};

export function homeCountry(tz: string | undefined): string {
  return (tz && ZONES[tz]) || 'TW';
}

/**
 * The address a peer says it sees us at: BEP 10's "yourip" in the extended handshake, 4 bytes for
 * IPv4 and 16 for IPv6. qBittorrent, Deluge and Transmission send it; WebTorrent does not.
 */
export function yourIp(v: unknown): string | null {
  if (!(v instanceof Uint8Array)) return null;
  if (v.length === 4) return Array.from(v).join('.');
  if (v.length === 16) {
    const groups: string[] = [];
    for (let i = 0; i < 16; i += 2) groups.push((((v[i] ?? 0) << 8) | (v[i + 1] ?? 0)).toString(16));
    return groups.join(':');
  }
  return null;
}

/** At most this many peers' reports are remembered; the oldest go first. */
const MAX_REPORTS = 200;

/**
 * Where this server is, for the map (Brian, 2026-10-06: detect it and centre the map on it). Peers
 * report the public address they see us at; each peer's report is one vote for that address's
 * country, and the country with the most votes wins. Nothing is asked of any outside service.
 * Until a peer has said anything, the time zone's guess stands. Kept in memory: the map is only
 * shown while peers are connected, and they report again after a restart.
 */
export class HomeFinder {
  private readonly votes = new Map<string, string>();
  private found: string | null = null;
  private readonly fallback: string;

  constructor(fallback: string) {
    this.fallback = fallback;
  }

  get current(): string {
    return this.found ?? this.fallback;
  }

  get from(): 'peers' | 'timezone' {
    return this.found ? 'peers' : 'timezone';
  }

  observe(reports: ReadonlyArray<{ peer: string; yourIp: string | null }>, geo: CountryLookup): void {
    let changed = false;
    for (const r of reports) {
      if (!r.yourIp || isInternalAddress(r.yourIp)) continue;
      const country = geo.country(r.yourIp);
      if (!country || this.votes.get(r.peer) === country) continue;
      this.votes.delete(r.peer);
      this.votes.set(r.peer, country);
      if (this.votes.size > MAX_REPORTS) this.votes.delete(this.votes.keys().next().value as string);
      changed = true;
    }
    if (!changed) return;
    const counts = new Map<string, number>();
    for (const c of this.votes.values()) counts.set(c, (counts.get(c) ?? 0) + 1);
    let best = this.found;
    let bestN = best ? (counts.get(best) ?? 0) : 0;
    // A tie keeps the country already shown, so the map does not flip back and forth.
    for (const [c, n] of counts) if (n > bestN) [best, bestN] = [c, n];
    this.found = best;
  }
}

/** "61.220.x.x", "2001:db8:x": enough to tell connections apart, not enough to identify anyone. */
export function maskAddress(ip: string): string {
  const plain = ip.replace(/^::ffff:/i, '');
  if (isIPv4(plain)) return `${plain.split('.').slice(0, 2).join('.')}.x.x`;
  return `${plain.split(':').slice(0, 2).join(':')}:x`;
}

const salt = randomBytes(8);
const peerKey = (address: string, port: number) =>
  createHash('sha256').update(salt).update(`${address}:${port}`).digest('hex').slice(0, 12);

/** Base64 of a bit buffer, as the page reads it. */
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

export function buildLive(
  snap: EngineSnapshot | null,
  speed: { downBps: number; upBps: number },
  history: ReadonlyArray<{ downBps: number; upBps: number }>,
  geo: CountryLookup,
  home: { country: string; from: 'peers' | 'timezone' },
  now = new Date(),
): TorrentLive {
  const peers: TorrentLivePeer[] = (snap?.peers ?? []).map((p) => {
    const local = isInternalAddress(p.address);
    const t = p.type.toLowerCase();
    return {
      id: peerKey(p.address, p.port),
      address: maskAddress(p.address),
      country: local ? null : geo.country(p.address),
      local,
      client: clientName(p.peerId, p.clientVersion),
      direction: t.includes('incoming') ? 'in' : 'out',
      transport: t.includes('utp') ? 'utp' : t.includes('webseed') ? 'http' : 'tcp',
      downBps: p.downBps,
      upBps: p.upBps,
      has: snap?.pieceCount ? Math.round((p.pieces / snap.pieceCount) * 1000) / 1000 : 0,
    };
  });
  // Busiest first: the list and the map's brightest lines agree.
  peers.sort((a, b) => b.downBps + b.upBps - (a.downBps + a.upBps) || b.has - a.has);
  return {
    at: now.toISOString(),
    downBps: Math.max(0, Math.round(speed.downBps)),
    upBps: Math.max(0, Math.round(speed.upBps)),
    history: history
      .slice(-HISTORY_POINTS)
      .map((h) => ({ downBps: Math.round(h.downBps), upBps: Math.round(h.upBps) })),
    pieces: snap
      ? {
          count: snap.pieceCount,
          size: snap.pieceLength,
          have: b64(snap.have),
          active: b64(snap.active),
          availability: b64(snap.availability),
        }
      : null,
    peers,
    home: home.country,
    homeFrom: home.from,
  };
}
