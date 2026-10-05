import WebTorrent from 'webtorrent';

/**
 * The only file that touches WebTorrent's untyped API (AGENTS.md: wrap third-party boundaries).
 * Everything the worker needs, behaviour confirmed by reference/torrent/local-swarm-test.mjs and
 * phase 0 against the public swarm.
 */
export type EngineFile = { path: string; length: number };

export type EngineTorrent = {
  readonly infoHash: string;
  readonly ready: boolean;
  readonly done: boolean;
  readonly progress: number;
  readonly downloaded: number;
  readonly uploaded: number;
  readonly downloadSpeed: number;
  readonly numPeers: number;
  readonly length: number;
  readonly files: EngineFile[];
  /** Pieces on disk, for fast resume. Null before the metadata arrived. */
  bitfield(): Buffer | null;
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
  numPeers: number;
  length: number;
  files: { path: string; length: number }[];
  bitfield?: { buffer: Uint8Array };
  on(event: string, fn: (...args: unknown[]) => void): void;
  addPeer(addr: string): void;
  destroy(opts: { destroyStore: boolean }, cb: (err?: Error) => void): void;
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
    on(event: string, fn: (...args: never[]) => void) {
      if (event === 'wire')
        t.on('wire', (wire: unknown) => (fn as (type: string) => void)(String((wire as { type?: string }).type ?? '')));
      else t.on(event, fn as (...args: unknown[]) => void);
    },
    addPeer: (addr) => t.addPeer(addr),
    stop: () => new Promise((resolve) => t.destroy({ destroyStore: false }, () => resolve())),
  };
}
