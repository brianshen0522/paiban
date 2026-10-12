import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import bencode from 'bencode';
import parseTorrent from 'parse-torrent';
import { z } from 'zod';
import { mainVideo } from '../torrent/schedule.js';

/**
 * Torrents added by hand (Brian, 2026-10-09; D26 changed): reading a magnet link or a .torrent
 * file someone gave us. Everything in them is untrusted: only the info hash, the trackers that
 * pass `safeTrackers` and the info dictionary are kept. Web seeds, "x.pe" peers and the rest are
 * dropped, so WebTorrent never fetches an address a person typed.
 */
export class MetainfoError extends Error {
  readonly code: 'BAD_MAGNET' | 'BAD_TORRENT';
  constructor(code: MetainfoError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

export type TorrentFileEntry = { path: string; length: number };

/** What a torrent holds, read from its info dictionary. */
export type Metainfo = {
  infoHash: string;
  name: string;
  files: TorrentFileEntry[];
  length: number;
  /** Bencoded `{info}` and nothing else: what is stored and handed to WebTorrent. */
  metainfo: Buffer;
};

/** At most this many trackers are kept from a link or file. */
const MAX_TRACKERS = 20;
/** A .torrent file larger than this is refused (the piece hashes of a 100 GB film are ~1 MB). */
export const MAX_TORRENT_FILE_BYTES = 4 * 1024 * 1024;

const Parsed = z.object({
  infoHash: z.string().regex(/^[0-9a-fA-F]{40}$/),
  name: z.string().optional(),
  announce: z.array(z.string()).optional(),
  files: z.array(z.object({ path: z.string(), length: z.number().nonnegative() })).optional(),
  info: z.unknown().optional(),
});

/** Private, loopback and link-local hosts: a tracker there would make WebTorrent reach inside the network. */
function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (isIP(h) === 4) {
    const [a = 0, b = 0] = h.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (isIP(h) === 6)
    return (
      h === '::1' ||
      h === '::' ||
      h.startsWith('fc') ||
      h.startsWith('fd') ||
      h.startsWith('fe80') ||
      h.startsWith('::ffff:')
    );
  return !h.includes('.');
}

/** The trackers worth keeping: udp, http(s) or ws(s), public hosts, each once, at most 20. */
export function safeTrackers(list: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    if (out.length >= MAX_TRACKERS) break;
    if (raw.length > 300) continue;
    let url: URL;
    try {
      url = new URL(raw.trim());
    } catch {
      continue;
    }
    if (!['udp:', 'http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) continue;
    if (!url.hostname || privateHost(url.hostname) || url.username || url.password) continue;
    const s = url.toString();
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** A magnet link: its info hash (hex, lower case) and trackers. Base32 hashes are turned into hex. */
export async function readMagnet(text: string): Promise<{ infoHash: string; trackers: string[] }> {
  const link = text.trim();
  if (!/^magnet:\?/i.test(link) || link.length > 8000) throw new MetainfoError('BAD_MAGNET', 'not a magnet link');
  let parsed: z.infer<typeof Parsed>;
  try {
    parsed = Parsed.parse(await parseTorrent(link));
  } catch {
    throw new MetainfoError('BAD_MAGNET', 'the magnet link has no BitTorrent info hash');
  }
  return { infoHash: parsed.infoHash.toLowerCase(), trackers: safeTrackers(parsed.announce ?? []) };
}

/** A .torrent file: what it holds, its trackers, and the stored form of its info dictionary. */
export async function readTorrentFile(buf: Buffer): Promise<{ meta: Metainfo; trackers: string[] }> {
  if (buf.length === 0 || buf.length > MAX_TORRENT_FILE_BYTES)
    throw new MetainfoError('BAD_TORRENT', 'empty or too large');
  let parsed: z.infer<typeof Parsed>;
  try {
    parsed = Parsed.parse(await parseTorrent(new Uint8Array(buf)));
  } catch {
    throw new MetainfoError('BAD_TORRENT', 'not a BitTorrent v1 metainfo file');
  }
  if (!parsed.info) throw new MetainfoError('BAD_TORRENT', 'no info dictionary');
  const metainfo = Buffer.from(bencode.encode({ info: parsed.info }));
  const meta = await decodeMetainfo(metainfo);
  if (meta.infoHash !== parsed.infoHash.toLowerCase())
    throw new MetainfoError('BAD_TORRENT', 'the info dictionary does not round-trip');
  return { meta, trackers: safeTrackers(parsed.announce ?? []) };
}

/** Reads the stored `{info}` (from a file, or fetched from the swarm by the torrent service). */
export async function decodeMetainfo(metainfo: Buffer): Promise<Metainfo> {
  let parsed: z.infer<typeof Parsed>;
  try {
    parsed = Parsed.parse(await parseTorrent(new Uint8Array(metainfo)));
  } catch {
    throw new MetainfoError('BAD_TORRENT', 'not a BitTorrent v1 info dictionary');
  }
  const decoded = bencode.decode(new Uint8Array(metainfo)) as { info?: unknown };
  const hash = createHash('sha1')
    .update(bencode.encode(decoded.info ?? {}))
    .digest('hex');
  const files = (parsed.files ?? []).map((f) => ({ path: f.path, length: f.length }));
  if (!files.length) throw new MetainfoError('BAD_TORRENT', 'no files');
  return {
    infoHash: hash,
    name: (parsed.name ?? '').slice(0, 300),
    files,
    length: files.reduce((n, f) => n + f.length, 0),
    metainfo,
  };
}

/** The file that gets downloaded: the largest video (docs/06-torrent-worker.md, "Adding by hand"). */
export const chosenFile = (meta: Pick<Metainfo, 'files'>): TorrentFileEntry | null => mainVideo(meta.files);

/** What a release name says about the version, for the downloads list (by hand nothing else says it). */
export function guessVersion(name: string): {
  quality: string;
  source: string;
  videoCodec: string;
  bitDepth: number;
} {
  const n = name.toLowerCase();
  const quality = /2160p|\b4k\b|uhd/.test(n)
    ? '2160p'
    : /1080p/.test(n)
      ? '1080p'
      : /720p/.test(n)
        ? '720p'
        : /480p/.test(n)
          ? '480p'
          : '';
  const source = /blu-?ray|bdrip|brrip|bdremux/.test(n)
    ? 'bluray'
    : /web-?dl|webrip|\bweb\b/.test(n)
      ? 'web'
      : /hdtv/.test(n)
        ? 'tv'
        : /dvd/.test(n)
          ? 'dvd'
          : '';
  const videoCodec = /x265|h\.?265|hevc/.test(n) ? 'x265' : /x264|h\.?264|avc/.test(n) ? 'x264' : '';
  const bitDepth = /10.?bit|hdr|\bdv\b|dolby.?vision/.test(n) ? 10 : 8;
  return { quality, source, videoCodec, bitDepth };
}
