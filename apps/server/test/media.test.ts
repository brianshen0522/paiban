import { execFileSync, spawnSync } from 'node:child_process';
import { access, chmod, copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MediaService } from '../src/media/service.js';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

/**
 * The media service against the fixtures (docs/14-plan.md, phase 4). Needs ffmpeg and ffsubsync:
 * they are in the image, so `pnpm test:image` runs this file for real; on a machine without them it
 * is skipped, loudly.
 */
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const TOOLS = has('ffmpeg', ['-version']) && has(process.env.FFSUBSYNC ?? 'ffsubsync', ['--version']);
if (!TOOLS)
  console.warn(
    'media.test.ts SKIPPED: ffmpeg or ffsubsync not found here. Run `pnpm test:image` to run it inside the image.',
  );

const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let mei: string;
let meiId: string;
let service: MediaService;
let n = 0;

async function until(check: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error('condition not met in time');
}

/** A finished download of `file`, as the torrent service leaves it, with the given preview plan. */
async function film(
  file: string,
  plan: {
    audio?: boolean;
    proxy?: '480p' | '720p' | null;
    analysis?: 'pending' | 'none';
    predictDirect?: boolean;
    reserve?: number;
  } = {},
) {
  n++;
  const hash = (0xabc000 + n).toString(16).padStart(40, '0');
  const dir = join(t.deps.config.dataDir, 'torrents', hash);
  await mkdir(dir, { recursive: true });
  const name = file.split('/').pop() as string;
  await copyFile(file, join(dir, name));
  const movie = (
    await db.pool.query(
      `insert into movies (yts_id, imdb_code, title, year, runtime_min) values ($1, 'tt1', $2, 2026, 2) returning id`,
      [n, `Clip ${n}`],
    )
  ).rows[0].id;
  const tid = (
    await db.pool.query(
      `insert into torrents (info_hash, movie_id, quality, video_codec, size_bytes, state, disk_bytes) values ($1, $2, '1080p', 'x264', 1000, 'completed', 1000) returning id`,
      [hash, movie],
    )
  ).rows[0].id;
  await db.pool.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [tid, meiId]);
  const mid = (
    await db.pool.query(
      `insert into media_files (torrent_id, rel_path, size_bytes, direct_play, analysis_state, audio_state, proxy_state, proxy_res, reserve_bytes)
       values ($1, $2, 1000, $3, $4, $5, $6, $7, $8) returning id`,
      [
        tid,
        name,
        plan.predictDirect ?? true,
        plan.analysis ?? 'pending',
        plan.audio ? 'pending' : 'none',
        plan.proxy ? 'pending' : 'none',
        plan.proxy ?? null,
        plan.reserve ?? 0,
      ],
    )
  ).rows[0].id;
  return { tid, mid, hash, name };
}
const media = async (id: string) => (await db.pool.query('select * from media_files where id = $1', [id])).rows[0];

describe.skipIf(!TOOLS)('the media service', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    db = await testDb();
    t = await testApp(db.pool);
    meiId = await createUser(db.pool, 'mei');
    mei = await login(t.app, 'mei');
    service = new MediaService({
      pool: db.pool,
      config: t.deps.config,
      log: pino({ level: 'silent' }),
      disk: t.deps.disk,
    });
    await service.start();
  });
  afterAll(async () => {
    service?.stop();
    await t?.app.close();
    await db?.drop();
  });
  beforeEach(async () => {
    await setLimit(db.pool, 100 * GB);
  });

  it('analyses clip.mp4 into exactly the waveform and speech of fixtures/data.json', async () => {
    const f = await film(fixture('clip.mp4'));
    await service.reconcile();
    await until(async () => (await media(f.mid)).analysis_state === 'ready');
    const data = JSON.parse(await readFile(fixture('data.json'), 'utf8'));
    const speech = (await call(t.app, 'GET', `/api/media/${f.mid}/speech`, { cookie: mei })).json();
    expect(speech).toEqual({ hz: 100, frames: data.speechFrames, segments: data.speech });
    const peaks = await call(t.app, 'GET', `/api/media/${f.mid}/peaks`, { cookie: mei });
    expect(peaks.rawPayload.equals(Buffer.from(data.peaks, 'base64'))).toBe(true);
    const m = await media(f.mid);
    expect(m).toMatchObject({ probe_state: 'ready', direct_play: true, video_codec: 'h264' });
    expect(m.analysis_bytes).toBeGreaterThan(0);
    const status = (await call(t.app, 'GET', `/api/media/${f.mid}`, { cookie: mei })).json();
    expect(status.sources).toEqual([{ kind: 'original', url: `/api/media/${f.mid}/original`, mime: 'video/mp4' }]);
    const tasks = (
      await db.pool.query(`select state from tasks where kind = 'analyze' and input->>'mediaId' = $1`, [f.mid])
    ).rows;
    expect(tasks).toEqual([{ state: 'done' }]);
  });

  it.skipIf(!process.env.ASR_PYTHON)(
    'recognises the speech of clip.mp4 after the analysis, well enough to pair it with the subtitle',
    { timeout: 300_000 },
    async () => {
      const f = await film(fixture('clip.mp4'));
      await service.reconcile();
      await until(async () => ['ready', 'failed'].includes((await media(f.mid)).asr_state), 280_000);
      const m = await media(f.mid);
      expect(m).toMatchObject({ asr_state: 'ready', asr_language: 'en' });
      const heard = JSON.parse(await readFile(join(t.deps.config.dataDir, 'media', f.mid, 'asr.json'), 'utf8'));
      expect(heard.windows.length).toBeGreaterThanOrEqual(2);
      const { parseSrt } = await import('../src/subtitles/text.js');
      const { textPairs } = await import('../src/asr/text.js');
      const truth = parseSrt(await readFile(fixture('truth.en.srt'), 'utf8')).map((c, i) => ({ ...c, id: i + 1 }));
      const pairs = textPairs(truth, heard);
      expect(pairs.length).toBeGreaterThanOrEqual(5);
      for (const p of pairs) expect(Math.abs(truth[p.cue].start - p.y)).toBeLessThan(0.5);
      const status = (await call(t.app, 'GET', `/api/media/${f.mid}`, { cookie: mei })).json();
      expect(status.asr).toEqual({ state: 'ready', language: 'en' });
    },
  );

  it('streams the original with Range, to holders only', async () => {
    const f = await film(fixture('clip.mp4'), { analysis: 'none' });
    const res = await call(t.app, 'GET', `/api/media/${f.mid}/original`, {
      cookie: mei,
      headers: { range: 'bytes=100-199' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toMatch(/^bytes 100-199\/\d+$/);
    expect(res.rawPayload.equals((await readFile(fixture('clip.mp4'))).subarray(100, 200))).toBe(true);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(
      (await call(t.app, 'GET', `/api/media/${f.mid}/original`, { cookie: mei, headers: { range: 'bytes=99999999-' } }))
        .statusCode,
    ).toBe(416);
    expect((await call(t.app, 'GET', `/api/media/${f.mid}/original`)).statusCode).toBe(401);
    await createUser(db.pool, 'stranger');
    const s = await login(t.app, 'stranger');
    expect((await call(t.app, 'GET', `/api/media/${f.mid}/original`, { cookie: s })).statusCode).toBe(403);
  });

  it('waits for someone to ask when automatic analysis is off, then analyses', async () => {
    const f = await film(fixture('clip.mp4'), { analysis: 'none' });
    await service.reconcile();
    await until(async () => (await media(f.mid)).probe_state === 'ready');
    await sleep(500);
    expect((await media(f.mid)).analysis_state).toBe('none');
    expect((await call(t.app, 'GET', `/api/media/${f.mid}/peaks`, { cookie: mei })).statusCode).toBe(404);
    expect((await call(t.app, 'POST', `/api/media/${f.mid}/analyze`, { cookie: mei })).json().analysis).toBe('pending');
    await service.reconcile();
    await until(async () => (await media(f.mid)).analysis_state === 'ready');
  });

  it('makes the audio file and a frame-exact H.264 preview for HEVC 10-bit, then counts real sizes', async () => {
    const f = await film(fixture('clip.hevc10.mp4'), {
      predictDirect: false,
      audio: true,
      proxy: '480p',
      reserve: 50_000_000,
    });
    await service.reconcile();
    await until(async () => {
      const m = await media(f.mid);
      return m.audio_state === 'ready' && m.proxy_state === 'ready';
    });
    const m = await media(f.mid);
    expect(m.reserve_bytes).toBe(0);
    expect(m.audio_bytes).toBeGreaterThan(0);
    expect(m.proxy_bytes).toBeGreaterThan(0);
    const proxy = join(t.deps.config.dataDir, 'media', f.mid, 'proxy.mp4');
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', proxy], { encoding: 'utf8' }),
    );
    expect(probe.streams.map((s: { codec_name: string }) => s.codec_name)).toEqual(['h264', 'aac']);
    const times = (file: string) =>
      execFileSync(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', file],
        { encoding: 'utf8' },
      )
        .trim()
        .split('\n')
        .map((l) => l.split(',')[0]);
    expect(times(proxy)).toEqual(times(join(t.deps.config.dataDir, 'torrents', f.hash, f.name)));
    const status = (await call(t.app, 'GET', `/api/media/${f.mid}`, { cookie: mei })).json();
    expect(status.sources.map((s: { kind: string }) => s.kind)).toEqual(['proxy', 'audio']);
    const usage = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage;
    expect(usage.categories.previews).toBeGreaterThanOrEqual(m.audio_bytes + m.proxy_bytes);
  });

  it('adds a preview plan when YTS called it x264 but it is HEVC, or says why when there is no room', async () => {
    const roomy = await film(fixture('clip.hevc10.mp4'), { predictDirect: true, analysis: 'none' });
    await service.reconcile();
    await until(async () => (await media(roomy.mid)).probe_state === 'ready');
    const r = await media(roomy.mid);
    expect(r.direct_play).toBe(false);
    expect(['pending', 'running', 'ready']).toContain(r.audio_state);
    await until(async () => (await media(roomy.mid)).proxy_state === 'ready');

    await setLimit(db.pool, 1);
    const tight = await film(fixture('clip.hevc10.mp4'), { predictDirect: true, analysis: 'none' });
    await service.reconcile();
    await until(async () => (await media(tight.mid)).probe_state === 'ready');
    const m = await media(tight.mid);
    expect(m.proxy_state).toBe('none');
    expect(m.error).toMatchObject({ proxy: 'PREVIEW_NO_SPACE' });
    const status = (await call(t.app, 'GET', `/api/media/${tight.mid}`, { cookie: mei })).json();
    expect(status.errors.proxy).toBe('PREVIEW_NO_SPACE');
    expect(status.previewNeedBytes).toBeGreaterThan(0);
    const asked = await call(t.app, 'POST', `/api/media/${tight.mid}/proxy`, { cookie: mei });
    expect(asked.json().error.code).toBe('STORAGE_LIMIT');
  });

  it('marks a file without audio NO_AUDIO, still makes the preview video, and still answers', async () => {
    const silent = join(await mkdtemp(join(tmpdir(), 'silent-')), 'silent.mkv');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', fixture('clip.hevc10.mp4'), '-an', '-c', 'copy', silent]);
    const f = await film(silent, { predictDirect: false, audio: true, proxy: '480p', reserve: 50_000_000 });
    await service.reconcile();
    await until(async () => (await media(f.mid)).proxy_state === 'ready');
    const m = await media(f.mid);
    expect(m).toMatchObject({ analysis_state: 'failed', audio_state: 'none', error: { analysis: 'NO_AUDIO' } });
    expect((await call(t.app, 'GET', `/api/torrents/${f.tid}`, { cookie: mei })).json().media.errors.analysis).toBe(
      'NO_AUDIO',
    );
  });

  it('stops ffmpeg and leaves nothing when the preview is deleted while converting', async () => {
    await createUser(db.pool, 'boss', 'admin');
    const boss = await login(t.app, 'boss');
    await setSetting(db.pool, 'media.analyzeAuto', false);
    const f = await film(fixture('clip.hevc10.mp4'), {
      predictDirect: false,
      proxy: '720p',
      reserve: 50_000_000,
      analysis: 'none',
    });
    await service.reconcile();
    await until(async () => (await media(f.mid)).proxy_state === 'running', 30_000);
    const res = await call(t.app, 'DELETE', `/api/admin/storage/items/preview/${f.mid}`, { cookie: boss });
    expect(res.statusCode).toBe(200);
    await sleep(3500);
    const files = await readdir(join(t.deps.config.dataDir, 'media', f.mid)).catch(() => []);
    expect(files.filter((x) => x.startsWith('proxy'))).toEqual([]);
    expect((await media(f.mid)).proxy_state).toBe('none');
  });

  it('retries a failing transcode once, then fails it and releases its reservation', async () => {
    // A stand-in ffmpeg that refuses to encode H.264; everything else goes to the real one.
    const bin = await mkdtemp(join(tmpdir(), 'fakebin-'));
    const real = execFileSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' }).trim();
    await writeFile(
      join(bin, 'ffmpeg'),
      `#!/bin/sh\ncase "$*" in *libx264*) echo refused >&2; exit 1;; esac\nexec ${real} "$@"\n`,
    );
    await chmod(join(bin, 'ffmpeg'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const f = await film(fixture('clip.hevc10.mp4'), {
        predictDirect: false,
        proxy: '480p',
        reserve: 20_000_000,
        analysis: 'none',
      });
      await service.reconcile();
      await until(
        async () =>
          (await db.pool.query(`select attempts from tasks where kind = 'preview' and input->>'mediaId' = $1`, [f.mid]))
            .rows[0]?.attempts === 1,
      );
      expect((await media(f.mid)).reserve_bytes).toBeGreaterThan(0); // the first failure keeps the reservation
      await service.reconcile(); // the next reconciliation is the second try
      await until(async () => (await media(f.mid)).proxy_state === 'failed');
      const m = await media(f.mid);
      expect(m.error).toMatchObject({ proxy: 'TRANSCODE_FAILED' });
      expect(m.reserve_bytes).toBe(0);
      expect(
        (
          await db.pool.query(`select state, error_code from tasks where kind = 'preview' and input->>'mediaId' = $1`, [
            f.mid,
          ])
        ).rows,
      ).toEqual([{ state: 'failed', error_code: 'TRANSCODE_FAILED' }]);
    } finally {
      process.env.PATH = path;
    }
  });

  it('picks up after a restart: work back to waiting, half-written files gone, done once', async () => {
    const f = await film(fixture('clip.mp4'));
    await db.pool.query(`update media_files set probe_state = 'ready', analysis_state = 'running' where id = $1`, [
      f.mid,
    ]);
    const dir = join(t.deps.config.dataDir, 'media', f.mid);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'proxy.mp4.part'), 'half');
    const fresh = new MediaService({
      pool: db.pool,
      config: t.deps.config,
      log: pino({ level: 'silent' }),
      disk: t.deps.disk,
    });
    const twin = new MediaService({
      pool: db.pool,
      config: t.deps.config,
      log: pino({ level: 'silent' }),
      disk: t.deps.disk,
    });
    await fresh.start();
    expect(await exists(join(dir, 'proxy.mp4.part'))).toBe(false);
    await twin.reconcile(); // a second scheduler racing for the same row
    await until(async () => (await media(f.mid)).analysis_state === 'ready');
    fresh.stop();
    twin.stop();
    const done = (
      await db.pool.query(`select count(*)::int as n from tasks where kind = 'analyze' and input->>'mediaId' = $1`, [
        f.mid,
      ])
    ).rows[0].n;
    expect(done).toBe(1);
  });

  it('recalculation finds orphans and missing files and deletes nothing', async () => {
    const f = await film(fixture('clip.mp4'), { analysis: 'none' });
    await db.pool.query(`update media_files set probe_state = 'ready' where id = $1`, [f.mid]);
    const orphan = join(t.deps.config.dataDir, 'torrents', 'e'.repeat(40));
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, 'x.bin'), Buffer.alloc(4096));
    await import('node:fs/promises').then((fs) => fs.rm(join(t.deps.config.dataDir, 'torrents', f.hash, f.name)));
    await createUser(db.pool, 'boss2', 'admin');
    const boss = await login(t.app, 'boss2');
    const task = (await call(t.app, 'POST', '/api/admin/storage/rescan', { cookie: boss })).json();
    expect(task.kind).toBe('rescan');
    await service.reconcile();
    await until(
      async () => (await db.pool.query(`select state from tasks where id = $1`, [task.id])).rows[0].state === 'done',
    );
    const view = (await call(t.app, 'GET', '/api/admin/storage', { cookie: boss })).json();
    expect(
      view.findings.map((x: { kind: string; root: string; name: string }) => `${x.kind}:${x.root}:${x.name}`),
    ).toEqual(expect.arrayContaining([`orphan:torrents:${'e'.repeat(40)}`, `missing:torrents:${f.hash}`]));
    expect(view.rescan.summary).toMatchObject({ orphans: expect.any(Number), missing: expect.any(Number) });
    expect(await exists(join(orphan, 'x.bin'))).toBe(true);
  });
});
