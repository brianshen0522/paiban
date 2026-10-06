import WebTorrent from 'webtorrent';

/**
 * The only file that touches WebTorrent's untyped API (AGENTS.md: wrap third-party boundaries).
 * Everything the worker needs, behaviour confirmed by reference/torrent/local-swarm-test.mjs and
 * phase 0 against the public swarm.
 */
export type EngineFile = { path: string; length: number };

/** One open connection, as the download page shows it (docs/11-pages.md, "下載細節"). */
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

export type Engine = {
  add(magnet: string, opts: { path: string; bitfield?: Buffer; skipVerify?: boolean }): EngineTorrent;
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
  files: { path: string; length: number }[];
  bitfield?: { buffer: Uint8Array; get(i: number): boolean };
  wires?: WtWire[];
  _reservations?: (unknown[] | null)[];
  on(event: string, fn: (...args: unknown[]) => void): void;
  addPeer(addr: string): void;
  destroy(opts: { destroyStore: boolean }, cb: (err?: Error) => void): void;
};
type WtWire = {
  remoteAddress?: string;
  remotePort?: number;
  type?: string;
  peerId?: string | null;
  peerExtendedHandshake?: { v?: unknown };
  peerPieces?: { get(i: number): boolean };
  downloadSpeed?: () => number;
  uploadSpeed?: () => number;
};
type WtClient = {
  add(id: string, opts: object): WtTorrent;
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
    add(magnet, o) {
      const t = client.add(magnet, {
        path: o.path,
        ...(o.bitfield ? { bitfield: o.bitfield } : {}),
        ...(o.skipVerify ? { skipVerify: true } : {}),
        ...(opts.offline ? { announce: [] } : {}),
      });
      return wrap(t);
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

function wrap(t: WtTorrent): EngineTorrent {
  return {
    get infoHash() {
      return t.infoHash;
    },
    get ready() {
      return t.ready;
    },
    get done() {
      return t.done;
    },
    get progress() {
      return t.progress;
    },
    get downloaded() {
      return t.downloaded;
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
      return t.length;
    },
    get files() {
      return (t.files ?? []).map((f) => ({ path: f.path, length: f.length }));
    },
    bitfield: () => (t.bitfield ? Buffer.from(t.bitfield.buffer) : null),
    snapshot: () => snapshotOf(t),
    on(event: string, fn: (...args: never[]) => void) {
      if (event === 'wire')
        t.on('wire', (wire: unknown) => (fn as (type: string) => void)(String((wire as { type?: string }).type ?? '')));
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
    };
  });
  return { pieceCount: count, pieceLength: t.pieceLength, have, active, availability, peers };
}
