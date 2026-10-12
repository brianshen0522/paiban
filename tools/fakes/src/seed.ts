import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import WebTorrent from 'webtorrent';

/**
 * Seeds local files with every discovery mechanism off, so the torrent service can download them
 * by hash over 127.0.0.1 (docs/15-testing.md, "local seeding"; reference/torrent/local-swarm-test.mjs).
 * The hash depends on the content and piece size, so it is computed here and reported back.
 */
export type Seeded = { file: string; name: string; hash: string; length: number; torrentFile: Buffer };
/** Several files seeded as one torrent named `name` (a release with extras, for torrents added by hand). */
export type Pack = { name: string; files: string[] };
export type Seeder = { port: number; seeded: Seeded[]; close(): Promise<void> };

type Client = {
  seed(
    path: string | string[],
    opts: object,
    cb: (t: { infoHash: string; length: number; torrentFile: Uint8Array }) => void,
  ): void;
  on(e: 'error', fn: (err: Error) => void): void;
  destroy(cb: () => void): void;
};

export async function startSeeder(files: (string | Pack)[], port = 0): Promise<Seeder> {
  const usePort = port || 51_800 + Math.floor(Math.random() * 1000);
  const client = new (WebTorrent as unknown as new (o: object) => Client)({
    dht: false,
    tracker: false,
    lsd: false,
    natUpnp: false,
    natPmp: false,
    utPex: false,
    torrentPort: usePort,
  });
  client.on('error', (err) => {
    throw err;
  });
  const seeded: Seeded[] = [];
  for (const entry of files) {
    const pack = typeof entry === 'string' ? null : entry;
    const t = await new Promise<{ infoHash: string; length: number; torrentFile: Uint8Array }>((resolve) =>
      client.seed(
        pack ? pack.files : (entry as string),
        { announce: [], pieceLength: 16 * 1024, ...(pack ? { name: pack.name } : {}) },
        resolve,
      ),
    );
    const file = pack ? pack.name : (entry as string);
    seeded.push({
      file,
      name: pack ? pack.name : basename(file),
      hash: t.infoHash,
      length: pack ? t.length : (await stat(file)).size,
      torrentFile: Buffer.from(t.torrentFile),
    });
  }
  return { port: usePort, seeded, close: () => new Promise((r) => client.destroy(() => r())) };
}
