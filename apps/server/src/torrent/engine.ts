import bencode from 'bencode';
import MemoryChunkStore from 'memory-chunk-store';
import WebTorrent from 'webtorrent';
import { yourIp } from './live.js';
import { subtitleFiles, VIDEO_EXTENSIONS } from './schedule.js';

/**
 * The only file that touches WebTorrent's untyped API (AGENTS.md: wrap third-party boundaries).
 * Everything the worker needs, behaviour confirmed by reference/torrent/local-swarm-test.mjs and
 * phase 0 against the public swarm.
 */
export type EngineFile = { path: string; length: number };

/** One open connection, as the download page shows it (docs/11-pages.md, "Download details"). */
export type EnginePeer = {
  address: string;
  port: number;
  /** 'tcpIncoming', 'tcpOutgoing', 'utpIncoming', 'utpOutgoing', 'webSeed'. */
  type: string;
  /** Remote peer id as hex, and the client name it sent in the extended handshake, when it did. */
  peerId: string | null;
  clientVersion: string | null;
  downBps: number;
  upBps: number;
  /** How many of the torrent's pieces the peer has. */
  pieces: number;
  /** The address the peer says it sees us at (BEP 10 "yourip"), when it said. */
  yourIp: string | null;
};

/** What the engine knows about one torrent right now; null before its metadata arrived. */
export type EngineSnapshot = {
  pieceCount: number;
  pieceLength: number;
  /** Pieces on disk, one bit each, most significant bit first. */
  have: Buffer;
  /** Pieces being fetched right now (blocks reserved from some peer). */
  active: Buffer;
  /** For each piece, how many connected peers have it (at most 255). */
  availability: Uint8Array;
  peers: EnginePeer[];
};

export type EngineTorrent = {
  readonly infoHash: string;
  readonly ready: boolean;
  readonly done: boolean;
  readonly progress: number;
  readonly downloaded: number;
  readonly uploaded: number;
  readonly downloadSpeed: number;
  readonly uploadSpeed: number;
  readonly numPeers: number;
  readonly length: number;
  readonly files: EngineFile[];
  /** Pieces on disk, for fast resume. Null before the metadata arrived. */
  bitfield(): Buffer | null;
  snapshot(): EngineSnapshot | null;
  on(event: 'infoHash' | 'metadata' | 'ready' | 'done' | 'download', fn: () => void): void;
  on(event: 'error', fn: (err: Error) => void): void;
  on(event: 'warning', fn: (err: Error) => void): void;
  on(event: 'wire', fn: (type: string) => void): void;
  addPeer(addr: string): void;
  /** Leaves the client and keeps the files ("pause" in docs/06-torrent-worker.md). */
  stop(): Promise<void>;
};

export type EngineOptions = {
  torrentPort: number;
  dhtPort: number;
  downloadLimit: number;
  uploadLimit: number;
  /** Tests: no DHT, trackers or LSD; peers are added by hand. */
  offline: boolean;
};

export type AddOptions = {
  path: string;
  bitfield?: Buffer;
  skipVerify?: boolean;
  /** Trackers to announce to besides the magnet's own (a torrent added by hand keeps its own). */
  announce?: string[];
  /**
   * Only the largest video file, and the subtitle files beside it, are downloaded (torrents added
   * by hand, docs/06-torrent-worker.md, "Adding by hand"). `length`, `progress`, `downloaded`, `done` and
   * the `done` event are then those files' together.
   */
  onlyMainVideo?: boolean;
};

export type Engine = {
  /** A magnet link, or a stored `{info}` (bencoded) for a torrent added by hand. */
  add(source: string | Buffer, opts: AddOptions): EngineTorrent;
  /**
   * Fetches a magnet's metadata from the swarm into memory and leaves again: nothing is written
   * to disk. Answers the bencoded `{info}`. Rejects after `timeoutMs` without it.
   */
  fetchMetadata(magnet: string, timeoutMs: number, peers?: string[]): Promise<Buffer>;
  /**
   * Removes a torrent and deletes its files. Only storage/remove.ts may call this
   * (docs/10-storage.md: one module deletes under /data).
   */
  removeAndDeleteFiles(infoHash: string): Promise<void>;
  has(infoHash: string): boolean;
  throttle(downloadLimit: number, uploadLimit: number): void;
  onError(fn: (err: Error) => void): void;
  destroy(): Promise<void>;
};

type WtTorrent = {
  infoHash: string;
  ready: boolean;
  done: boolean;
  progress: number;
  downloaded: number;
  uploaded: number;
  downloadSpeed: number;
  uploadSpeed: number;
  numPeers: number;
  length: number;
  pieceLength: number;
  pieces: unknown[];
  files: WtFile[];
  info?: unknown;
  bitfield?: { buffer: Uint8Array; get(i: number): boolean };
  wires?: WtWire[];
  _reservations?: (unknown[] | null)[];
  on(event: string, fn: (...args: unknown[]) => void): void;
  addPeer(addr: string): void;
  destroy(opts: { destroyStore: boolean }, cb: (err?: Error) => void): void;
};
type WtFile = {
  path: string;
  length: number;
  done: boolean;
  progress: number;
  downloaded: number;
  select(): void;
  on(event: 'done', fn: () => void): void;
};
type WtWire = {
  remoteAddress?: string;
  remotePort?: number;
  type?: string;
  peerId?: string | null;
  peerExtendedHandshake?: { v?: unknown; yourip?: unknown };
  peerPieces?: { get(i: number): boolean };
  downloadSpeed?: () => number;
  uploadSpeed?: () => number;
};
type WtClient = {
  add(id: string | Uint8Array, opts: object): WtTorrent;
  remove(id: string, opts: { destroyStore: boolean }, cb: (err?: Error) => void): void;
  get(id: string): Promise<WtTorrent | null> | WtTorrent | null;
  torrents: WtTorrent[];
  throttleDownload(rate: number): void;
  throttleUpload(rate: number): void;
  on(event: 'error', fn: (err: Error) => void): void;
  destroy(cb: (err?: Error) => void): void;
};

const rate = (bytes: number) => (bytes > 0 ? bytes : -1);

export function createEngine(opts: EngineOptions): Engine {
  const client = new (WebTorrent as unknown as new (o: object) => WtClient)({
    torrentPort: opts.torrentPort,
    dhtPort: opts.dhtPort,
    natUpnp: false,
    natPmp: false,
    lsd: false,
    maxConns: 55,
    downloadLimit: rate(opts.downloadLimit),
    uploadLimit: rate(opts.uploadLimit),
    ...(opts.offline ? { dht: false, tracker: false, utPex: false } : {}),
  });
  const find = (hash: string) => client.torrents.find((t) => t.infoHash === hash);

  return {
    add(source, o) {
      const t = client.add(source, {
        path: o.path,
        ...(o.bitfield ? { bitfield: o.bitfield } : {}),
        ...(o.skipVerify ? { skipVerify: true } : {}),
        ...(o.onlyMainVideo ? { deselect: true } : {}),
        ...(opts.offline ? { announce: [] } : o.announce?.length ? { announce: o.announce } : {}),
      });
      return wrap(t, !!o.onlyMainVideo);
    },
    fetchMetadata(magnet, timeoutMs, peers = []) {
      return new Promise((resolve, reject) => {
        const hash = /btih:([0-9a-f]{40})/i.exec(magnet)?.[1]?.toLowerCase() ?? '';
        const existing = find(hash);
        if (existing?.info) return resolve(Buffer.from(bencode.encode({ info: existing.info })));
        if (existing) return reject(new Error('the torrent is open without its metadata yet'));
        let t: WtTorrent;
        try {
          t = client.add(magnet, {
            store: MemoryChunkStore,
            deselect: true,
            ...(opts.offline ? { announce: [] } : {}),
          });
        } catch (err) {
          return reject(err instanceof Error ? err : new Error(String(err)));
        }
        let settled = false;
        // The pieces live in memory (nothing was selected, so there are none): leaving is enough.
        const leave = () => setImmediate(() => t.destroy({ destroyStore: false }, () => undefined));
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          leave();
          reject(new Error('no metadata in time'));
        }, timeoutMs);
        t.on('metadata', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const info = t.info;
          leave();
          if (info) resolve(Buffer.from(bencode.encode({ info })));
          else reject(new Error('metadata without an info dictionary'));
        });
        t.on('error', (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          leave();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
        // Tests: no trackers or DHT, so the seeding peers are added by hand once the hash is known.
        if (peers.length)
          t.on('infoHash', () => {
            for (const p of peers) t.addPeer(p);
          });
      });
    },
    removeAndDeleteFiles(hash) {
      if (!find(hash)) return Promise.resolve();
      return new Promise((resolve, reject) =>
        client.remove(hash, { destroyStore: true }, (err) => (err ? reject(err) : resolve())),
      );
    },
    has: (hash) => !!find(hash),
    throttle(down, up) {
      client.throttleDownload(rate(down));
      client.throttleUpload(rate(up));
    },
    onError: (fn) => client.on('error', fn),
    destroy: () => new Promise((resolve) => client.destroy(() => resolve())),
  };
}

/** The largest video file, as schedule.ts's mainVideo picks it. */
function mainVideoFile(files: WtFile[]): WtFile | null {
  let best: WtFile | null = null;
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (!VIDEO_EXTENSIONS.some((e) => lower.endsWith(e))) continue;
    if (!best || f.length > best.length) best = f;
  }
  return best;
}

function wrap(t: WtTorrent, onlyMainVideo: boolean): EngineTorrent {
  // Only some files wanted: select them as soon as the metadata is in (before WebTorrent checks
  // which pieces are already on disk), and report them in place of the whole torrent.
  let wanted: WtFile[] = [];
  let fired = false;
  const doneListeners: (() => void)[] = [];
  const allDone = () => wanted.length > 0 && wanted.every((f) => f.done);
  const sum = (pick: (f: WtFile) => number) => wanted.reduce((n, f) => n + pick(f), 0);
  if (onlyMainVideo)
    t.on('metadata', () => {
      const main = mainVideoFile(t.files ?? []);
      if (!main) return;
      wanted = [main, ...subtitleFiles((t.files ?? []).filter((f) => f !== main))];
      for (const f of wanted) {
        f.select();
        f.on('done', () => {
          if (fired || !allDone()) return;
          fired = true;
          for (const fn of doneListeners) fn();
        });
      }
    });
  return {
    get infoHash() {
      return t.infoHash;
    },
    get ready() {
      return t.ready;
    },
    get done() {
      return onlyMainVideo ? allDone() : t.done;
    },
    get progress() {
      if (!onlyMainVideo) return t.progress;
      const total = sum((f) => f.length);
      return total ? sum((f) => f.downloaded) / total : 0;
    },
    get downloaded() {
      return onlyMainVideo ? sum((f) => f.downloaded) : t.downloaded;
    },
    get uploaded() {
      return t.uploaded;
    },
    get downloadSpeed() {
      return t.downloadSpeed;
    },
    get uploadSpeed() {
      return t.uploadSpeed;
    },
    get numPeers() {
      return t.numPeers;
    },
    get length() {
      return onlyMainVideo && wanted.length ? sum((f) => f.length) : t.length;
    },
    get files() {
      return (t.files ?? []).map((f) => ({ path: f.path, length: f.length }));
    },
    bitfield: () => (t.bitfield ? Buffer.from(t.bitfield.buffer) : null),
    snapshot: () => snapshotOf(t),
    on(event: string, fn: (...args: never[]) => void) {
      if (event === 'wire')
        t.on('wire', (wire: unknown) => (fn as (type: string) => void)(String((wire as { type?: string }).type ?? '')));
      else if (event === 'done' && onlyMainVideo) doneListeners.push(fn as () => void);
      else t.on(event, fn as (...args: unknown[]) => void);
    },
    addPeer: (addr) => t.addPeer(addr),
    stop: () => new Promise((resolve) => t.destroy({ destroyStore: false }, () => resolve())),
  };
}

const bitBuffer = (n: number) => Buffer.alloc(Math.ceil(n / 8));
const setBit = (b: Buffer, i: number) => {
  b[i >> 3] = (b[i >> 3] ?? 0) | (0x80 >> (i & 7));
};

/** Reads WebTorrent's per-connection and per-piece state; every field is checked, none trusted. */
function snapshotOf(t: WtTorrent): EngineSnapshot | null {
  const count = Array.isArray(t.pieces) ? t.pieces.length : 0;
  if (!t.ready || !t.bitfield || count === 0) return null;
  const have = bitBuffer(count);
  const active = bitBuffer(count);
  const availability = new Uint8Array(count);
  const wires = (t.wires ?? []).filter((w) => typeof w.remoteAddress === 'string');
  const reservations = t._reservations ?? [];
  for (let i = 0; i < count; i++) {
    if (t.bitfield.get(i)) setBit(have, i);
    else if ((reservations[i]?.length ?? 0) > 0) setBit(active, i);
  }
  const peers: EnginePeer[] = wires.map((w) => {
    let pieces = 0;
    for (let i = 0; i < count; i++) {
      if (w.peerPieces?.get(i)) {
        pieces++;
        availability[i] = Math.min(255, (availability[i] ?? 0) + 1);
      }
    }
    const v = w.peerExtendedHandshake?.v;
    return {
      address: w.remoteAddress ?? '',
      port: Number(w.remotePort ?? 0),
      type: String(w.type ?? ''),
      peerId: typeof w.peerId === 'string' ? w.peerId : null,
      clientVersion:
        typeof v === 'string'
          ? v
          : Buffer.isBuffer(v) || v instanceof Uint8Array
            ? Buffer.from(v).toString('utf8')
            : null,
      downBps: Math.max(0, Math.round(w.downloadSpeed?.() ?? 0)),
      upBps: Math.max(0, Math.round(w.uploadSpeed?.() ?? 0)),
      pieces,
      yourIp: yourIp(w.peerExtendedHandshake?.yourip),
    };
  });
  return { pieceCount: count, pieceLength: t.pieceLength, have, active, availability, peers };
}
