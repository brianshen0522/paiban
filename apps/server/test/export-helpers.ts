import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Cue, SyncCore, type SyncDoc } from '@paiban/shared';
import type { Pool } from '../src/db/pool.js';
import type { Engine } from '../src/torrent/engine.js';

/** Films and subtitles as the torrent service and the subtitle pages leave them, for export tests. */
export const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));

export function parseSrt(text: string): Cue[] {
  const t = (s: string) => {
    const [h, m, rest] = s.trim().split(':');
    return Number(h) * 3600 + Number(m) * 60 + Number(String(rest).replace(',', '.'));
  };
  return text
    .replace(/\r/g, '')
    .trim()
    .split(/\n\n+/)
    .map((block, i) => {
      const lines = block.split('\n');
      const [a, b] = String(lines[1]).split('-->');
      return { id: i + 1, start: t(String(a)), end: t(String(b)), text: lines.slice(2).join('\n') };
    });
}

let n = 0;

/** A finished download of `file` held by `holders`. */
export async function film(
  pool: Pool,
  dataDir: string,
  file: string,
  holders: string[],
  opts: { state?: 'completed' | 'downloading'; sizeBytes?: number } = {},
): Promise<{ tid: string; mid: string; hash: string; name: string }> {
  n++;
  const hash = createHash('sha1').update(`${randomUUID()}`).digest('hex');
  const name = file.split('/').pop() as string;
  const dir = join(dataDir, 'torrents', hash);
  await mkdir(dir, { recursive: true });
  await copyFile(file, join(dir, name));
  const size = opts.sizeBytes ?? (await readFile(file)).length;
  const movie = (
    await pool.query(
      `insert into movies (yts_id, imdb_code, title, year, runtime_min) values ($1, 'tt1', $2, 2026, 2) returning id`,
      [100_000 + Math.floor(Math.random() * 1e6), `Clip ${n}`],
    )
  ).rows[0].id;
  const tid = (
    await pool.query(
      `insert into torrents (info_hash, movie_id, quality, video_codec, size_bytes, state, disk_bytes) values ($1, $2, '1080p', 'x264', $3, $4, $3) returning id`,
      [hash, movie, size, opts.state ?? 'completed'],
    )
  ).rows[0].id;
  for (const h of holders)
    await pool.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [tid, h]);
  let mid = '';
  if ((opts.state ?? 'completed') === 'completed')
    mid = (
      await pool.query(
        `insert into media_files (torrent_id, rel_path, size_bytes, direct_play, probe_state, duration_s)
         values ($1, $2, $3, true, 'ready', 92.37) returning id`,
        [tid, name, size],
      )
    ).rows[0].id;
  return { tid, mid, hash, name };
}

/** A subtitle of `torrentId` with its cues.json and sync document. */
export async function subtitle(
  pool: Pool,
  dataDir: string,
  torrentId: string,
  srtFixture: string,
  opts: { language?: string; status?: 'draft' | 'confirmed'; doc?: SyncDoc } = {},
): Promise<{ id: string; cues: Cue[]; doc: SyncDoc }> {
  const id = randomUUID();
  const cues = parseSrt(await readFile(fixture(srtFixture), 'utf8'));
  const doc = opts.doc ?? SyncCore.identityDoc();
  const json = JSON.stringify(cues);
  await mkdir(join(dataDir, 'subtitles', id), { recursive: true });
  await writeFile(join(dataDir, 'subtitles', id, 'cues.json'), json);
  await pool.query(
    `insert into subtitles (id, torrent_id, provider, language, format, cue_count, rel_dir, sha256, status, doc, doc_rev)
     values ($1, $2, 'upload', $3, 'srt', $4, $5, $6, $7, $8, 3)`,
    [
      id,
      torrentId,
      opts.language ?? 'zh-Hant',
      cues.length,
      `subtitles/${id}`,
      createHash('sha256').update(json).digest('hex'),
      opts.status ?? 'confirmed',
      doc,
    ],
  );
  return { id, cues, doc };
}

/**
 * A WebTorrent stand-in for tests that only need the torrent loop to remove films: no sockets, so
 * it cannot take a port another test file's seeder is using. Starting a download is not expected.
 */
export function idleEngine(): Engine {
  return {
    add: () => {
      throw new Error('idleEngine does not download');
    },
    removeAndDeleteFiles: async () => undefined,
    has: () => false,
    throttle: () => undefined,
    onError: () => undefined,
    destroy: async () => undefined,
  };
}
