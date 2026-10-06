import { execFileSync, spawnSync } from 'node:child_process';
import { access, chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncCore } from '@paiban/shared';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MediaService } from '../src/media/service.js';
import type { Engine } from '../src/torrent/engine.js';
import { TorrentWorker } from '../src/torrent/worker.js';
import { film, fixture, idleEngine, subtitle } from './export-helpers.js';
import { call, createUser, GB, login, setLimit, type TestApp, testApp, testDb } from './helpers.js';

/**
 * The mux job against the fixtures (docs/08-media-pipeline.md, "封裝"; docs/10-storage.md, phase 7).
 * Needs ffmpeg and ffprobe: they are in the image, so `pnpm test:image test/exports-mux.test.ts`
 * runs this file for real; on a machine without them it is skipped, loudly.
 */
const has = (cmd: string) => spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0;
const TOOLS = has('ffmpeg') && has('ffprobe');
if (!TOOLS)
  console.warn(
    'exports-mux.test.ts SKIPPED: ffmpeg or ffprobe not found here. Run `pnpm test:image test/exports-mux.test.ts`.',
  );

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let meiId: string;
let mei: string;
let dataDir: string;
let service: MediaService;
let engine: Engine;
let worker: TorrentWorker;

/**
 * Waits for the job's last step on a finished export: the creator's notification is written after
 * the row, the tracks and the task are settled.
 */
async function noted(kind: 'export.completed' | 'export.failed', fileName: string): Promise<void> {
  await until(
    async () =>
      (await db.pool.query(`select 1 from notifications where kind = $1 and data->>'fileName' = $2`, [kind, fileName]))
        .rowCount === 1,
  );
}

async function until(check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(150);
  }
  throw new Error('condition not met in time');
}
const exp = async (id: string) => (await db.pool.query('select * from exports where id = $1', [id])).rows[0];
const taskOf = async (id: string) =>
  (await db.pool.query(`select state, error_code, attempts from tasks where input->>'exportId' = $1`, [id])).rows;

type Stream = {
  index: number;
  codec_type: string;
  codec_name: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};
const probe = (file: string): { streams: Stream[]; format: { tags?: Record<string, string> } } =>
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  );
/** Per-packet hashes of one stream: docs/08 says -c copy leaves every video and audio packet untouched. */
const packetHashes = (file: string, spec: string) =>
  execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', spec, '-c', 'copy', '-f', 'framemd5', '-'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    // stream, dts, pts, duration, size, hash[, side data]: the packet's own hash is the sixth field.
    .map((l) => l.split(',')[5]?.trim());
/** Subtitle cue times of one stream in the MKV, from its packets. */
const cueTimes = (file: string, streamIndex: number) =>
  execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      String(streamIndex),
      '-show_entries',
      'packet=pts_time,duration_time',
      '-of',
      'csv=p=0',
      file,
    ],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .map((l) => l.split(',').map(Number) as [number, number]);

/** ffmpeg processes still writing this export (from /proc: there is no pgrep in the image). */
async function muxesRunning(exportId: string): Promise<number> {
  let n = 0;
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    const cmd = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
    if (cmd.includes('matroska') && cmd.includes(exportId)) n++;
  }
  return n;
}

/** An ffmpeg in front of the real one, for the tests that need a slow or a failing mux. */
async function fakeFfmpeg(script: (real: string) => string): Promise<() => void> {
  const bin = await mkdtemp(join(tmpdir(), 'fakebin-'));
  const real = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
  await writeFile(join(bin, 'ffmpeg'), `#!/bin/sh\n${script(real)}\n`);
  await chmod(join(bin, 'ffmpeg'), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  return () => {
    process.env.PATH = path;
  };
}
/** Reads the source at its real speed, so a 92-second clip takes 92 seconds to mux. */
const slow = (real: string) => `case "$*" in *matroska*) exec ${real} -re "$@";; esac\nexec ${real} "$@"`;

describe.skipIf(!TOOLS)('the mux job', { timeout: 120_000 }, () => {
  beforeAll(async () => {
    db = await testDb();
    t = await testApp(db.pool);
    dataDir = t.deps.config.dataDir;
    meiId = await createUser(db.pool, 'mei');
    mei = await login(t.app, 'mei');
    service = new MediaService({
      pool: db.pool,
      config: t.deps.config,
      log: pino({ level: 'silent' }),
      disk: t.deps.disk,
    });
    await service.start();
    engine = idleEngine();
    worker = new TorrentWorker({
      pool: db.pool,
      config: t.deps.config,
      log: pino({ level: 'silent' }),
      engine,
      disk: t.deps.disk,
      now: () => Date.now(),
    });
  });
  afterAll(async () => {
    service?.stop();
    await engine?.destroy();
    await t?.app.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await setLimit(db.pool, 100 * GB);
    // Keep the analysis and preview queues out of the way: these films are already probed.
    await db.pool.query(`update media_files set analysis_state = 'none', audio_state = 'none', proxy_state = 'none'`);
  });

  /** A film with a confirmed Traditional Chinese (moved by 0.75 s) and English subtitle, and its export. */
  let k = 0;
  async function exportOf(source = fixture('clip.mp4'), fileName = `Clip.${++k}.zh-TW.mkv`) {
    const f = await film(db.pool, dataDir, source, [meiId]);
    const doc = SyncCore.identityDoc();
    doc.segments = [{ from: 0, scale: 1, offset: 0.75 }];
    const zh = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt', { doc });
    const en = await subtitle(db.pool, dataDir, f.tid, 'truth.en.srt', { language: 'en' });
    const res = await call(t.app, 'POST', `/api/torrents/${f.tid}/exports`, {
      cookie: mei,
      body: {
        fileName,
        tracks: [
          { subtitleId: zh.id, isDefault: true },
          { subtitleId: en.id, isDefault: false },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    return { f, zh, en, fileName, id: res.json().id as string, src: join(dataDir, 'torrents', f.hash, f.name) };
  }

  it('copies video and audio untouched and adds the two tracks with language, title and default', async () => {
    const { f, zh, en, id, src, fileName } = await exportOf();
    await service.reconcile();
    await noted('export.completed', fileName);
    const row = await exp(id);
    const out = join(dataDir, 'exports', id, fileName);
    expect(await readdir(join(dataDir, 'exports', id))).toEqual([fileName]); // tracks/ gone
    expect(row).toMatchObject({ reserved_bytes: 0, progress: 1, error_code: null });
    expect(row.size_bytes).toBeGreaterThan(1_000_000);
    expect(await taskOf(id)).toEqual([{ state: 'done', error_code: null, attempts: 0 }]);

    const p = probe(out);
    expect(p.format.tags?.title).toBe(
      `${(await db.pool.query('select title from movies m join torrents t on t.movie_id = m.id where t.id = $1', [f.tid])).rows[0].title} (2026)`,
    );
    expect(p.streams.map((s) => s.codec_type)).toEqual(['video', 'audio', 'subtitle', 'subtitle']);
    const subs = p.streams.filter((s) => s.codec_type === 'subtitle');
    expect(subs.map((s) => [s.codec_name, s.tags?.language, s.tags?.title, s.disposition?.default])).toEqual([
      ['subrip', 'chi', '繁體中文', 1],
      ['subrip', 'eng', 'English', 0],
    ]);
    // -c copy: every video and audio packet is the source's.
    expect(packetHashes(out, '0:v:0')).toEqual(packetHashes(src, '0:v:0'));
    expect(packetHashes(out, '0:a:0')).toEqual(packetHashes(src, '0:a:0'));

    // Subtitle times are applyDoc's, moved only by the container's common offset (docs/08, "時間").
    for (const [k, s] of [zh, en].entries()) {
      const want = SyncCore.applyDoc(s.cues, s.doc).filter((c) => !c.deleted);
      const got = cueTimes(out, subs[k]?.index ?? -1);
      expect(got).toHaveLength(want.length);
      const shift = (got[0]?.[0] ?? 0) - (want[0]?.start ?? 0);
      expect(Math.abs(shift)).toBeLessThan(0.1);
      for (const [i, c] of want.entries()) {
        expect(got[i]?.[0]).toBeCloseTo(c.start + shift, 2);
        expect(got[i]?.[1]).toBeCloseTo(c.end - c.start, 2);
      }
    }

    const note = (await db.pool.query(`select kind, data, link from notifications where kind = 'export.completed'`))
      .rows;
    expect(note).toContainEqual({
      kind: 'export.completed',
      data: expect.objectContaining({ fileName }),
      link: { page: 'workspace', torrentId: f.tid, tab: 'export' },
    });
    const usage = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage;
    expect(usage.categories.exports).toBeGreaterThanOrEqual(row.size_bytes);

    // Downloaded in two parts, as a resumed download would, it is the same file.
    const head = await call(t.app, 'GET', `/api/exports/${id}/file`, {
      cookie: mei,
      headers: { range: 'bytes=0-99999' },
    });
    const tail = await call(t.app, 'GET', `/api/exports/${id}/file`, {
      cookie: mei,
      headers: { range: 'bytes=100000-' },
    });
    expect(Buffer.concat([head.rawPayload, tail.rawPayload]).equals(await readFile(out))).toBe(true);
  });

  it('exports a source without an audio track', async () => {
    const silent = join(await mkdtemp(join(tmpdir(), 'silent-')), 'silent.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fixture('clip.mp4'), '-an', '-c', 'copy', silent]);
    const { id } = await exportOf(silent, 'silent.mkv');
    await service.reconcile();
    await until(async () => ['done', 'failed'].includes((await exp(id)).state));
    expect((await exp(id)).state).toBe('done');
    expect(probe(join(dataDir, 'exports', id, 'silent.mkv')).streams.map((s) => s.codec_type)).toEqual([
      'video',
      'subtitle',
      'subtitle',
    ]);
  });

  it('stops ffmpeg and leaves nothing when it is deleted while muxing', async () => {
    const restore = await fakeFfmpeg(slow);
    try {
      const { id, fileName } = await exportOf();
      await service.reconcile();
      await until(async () => exists(join(dataDir, 'exports', id, `${fileName}.part`)));
      expect((await exp(id)).state).toBe('running');
      const res = await call(t.app, 'DELETE', `/api/exports/${id}`, { cookie: mei });
      expect(res.statusCode).toBe(200);
      await until(async () => !(await exp(id)) && (await taskOf(id))[0]?.state === 'cancelled', 10_000);
      expect(await exists(join(dataDir, 'exports', id))).toBe(false);
      expect(await taskOf(id)).toEqual([{ state: 'cancelled', error_code: null, attempts: 0 }]);
      expect(await muxesRunning(id)).toBe(0);
    } finally {
      restore();
    }
  });

  it('cancels and deletes an export being written when its film is removed, leaving nothing', async () => {
    const restore = await fakeFfmpeg(slow);
    try {
      const { f, id, fileName } = await exportOf();
      await service.reconcile();
      await until(async () => exists(join(dataDir, 'exports', id, `${fileName}.part`)));
      await call(t.app, 'DELETE', `/api/torrents/${f.tid}/hold`, { cookie: mei });
      await worker.tick();
      await until(async () => !(await exists(join(dataDir, 'exports', id))), 10_000);
      await sleep(2500); // a last check from the job finds nothing to undo
      expect(await exists(join(dataDir, 'exports', id))).toBe(false);
      await until(async () => !(await exp(id)), 10_000);
      expect(await muxesRunning(id)).toBe(0);
    } finally {
      restore();
    }
  });

  it('tries a failing mux once more with its tracks and reservation, then fails and releases both', async () => {
    const restore = await fakeFfmpeg(
      (real) => `case "$*" in *matroska*) echo refused >&2; exit 1;; esac\nexec ${real} "$@"`,
    );
    try {
      const { id, fileName } = await exportOf();
      const reserved = (await exp(id)).reserved_bytes;
      await service.reconcile();
      await until(async () => (await taskOf(id))[0]?.attempts === 1);
      expect(await exp(id)).toMatchObject({ state: 'queued', reserved_bytes: reserved });
      expect(await readdir(join(dataDir, 'exports', id))).toEqual(['tracks']); // no .part
      await service.reconcile(); // the next reconciliation is the second try
      await noted('export.failed', fileName);
      expect(await exp(id)).toMatchObject({ error_code: 'MUX_FAILED', reserved_bytes: 0 });
      expect(await exists(join(dataDir, 'exports', id))).toBe(false);
      expect(await taskOf(id)).toEqual([{ state: 'failed', error_code: 'MUX_FAILED', attempts: 1 }]);
      const note = (await db.pool.query(`select data from notifications where kind = 'export.failed'`)).rows;
      expect(note).toContainEqual({ data: expect.objectContaining({ errorCode: 'MUX_FAILED' }) });
    } finally {
      restore();
    }
  });

  it('succeeds on the second try when the first one failed', async () => {
    const flag = join(await mkdtemp(join(tmpdir(), 'once-')), 'failed-once');
    const restore = await fakeFfmpeg(
      (real) =>
        `case "$*" in *matroska*) if [ ! -e ${flag} ]; then touch ${flag}; echo refused >&2; exit 1; fi;; esac\nexec ${real} "$@"`,
    );
    try {
      const { id, fileName } = await exportOf();
      await service.reconcile();
      await until(async () => (await taskOf(id))[0]?.attempts === 1);
      await service.reconcile();
      await noted('export.completed', fileName);
      expect(await taskOf(id)).toEqual([{ state: 'done', error_code: null, attempts: 1 }]);
    } finally {
      restore();
    }
  });
});
