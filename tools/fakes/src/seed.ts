import { stat } from 'node:fs/promises';
import { basename } from 'node:path';
import WebTorrent from 'webtorrent';

/**
 * Seeds local files with every discovery mechanism off, so the torrent service can download them
 * by hash over 127.0.0.1 (docs/15-testing.md, "本機做種"; reference/torrent/local-swarm-test.mjs).
 * The hash depends on the content and piece size, so it is computed here and reported back.
 */
export type Seeded = { file: string; name: string; hash: string; length: number };
export type Seeder = { port: number; seeded: Seeded[]; close(): Promise<void> };

type Client = {
  seed(path: string, opts: object, cb: (t: { infoHash: string; length: number }) => void): void;
  on(e: 'error', fn: (err: Error) => void): void;
  destroy(cb: () => void): void;
};

export async function startSeeder(files: string[], port = 0): Promise<Seeder> {
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
  for (const file of files) {
    const t = await new Promise<{ infoHash: string; length: number }>((resolve) =>
      client.seed(file, { announce: [], pieceLength: 16 * 1024 }, resolve),
    );
    seeded.push({ file, name: basename(file), hash: t.infoHash, length: (await stat(file)).size });
  }
  return { port: usePort, seeded, close: () => new Promise((r) => client.destroy(() => r())) };
}
