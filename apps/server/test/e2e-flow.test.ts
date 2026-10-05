import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Seeder, startSeeder } from '@paiban/fakes/seed';
import { type FakeSources, startFakeSources } from '@paiban/fakes/subtitles';
import { type FakeYts, startFakeYts } from '@paiban/fakes/yts';
import { type Cue, SyncCore, type SyncDoc } from '@paiban/shared';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaService } from '../src/media/service.js';
import { createEngine, type Engine } from '../src/torrent/engine.js';
import { TorrentWorker } from '../src/torrent/worker.js';
import { fixture, parseSrt } from './export-helpers.js';
import {
  call,
  createUser,
  GB,
  login,
  PUBLIC_URL,
  setLimit,
  setSetting,
  type TestApp,
  testApp,
  testDb,
} from './helpers.js';

/**
 * The whole product flow, offline, at the API level (docs/14-plan.md phase 9; docs/15-testing.md,
 * "離線的完整流程"): search the fake YTS, download a version the local seeder serves, analyse it,
 * find subtitles on the fake sources, upload one, auto-align, confirm, export two tracks, download
 * the MKV in two ranges, then remove the film and the export and find nothing left behind.
 *
 * The api, the torrent service and the media service all run here over one data folder, driven the
 * way their own loops drive them. Needs ffmpeg, ffprobe, ffsubsync and bsdtar: they are in the
 * image, so `pnpm test:image test/e2e-flow.test.ts` runs this for real; elsewhere it is skipped,
 * loudly. Speech recognition runs too when ASR_PYTHON is set (it is in the image).
 */
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const TOOLS =
  has('ffmpeg', ['-version']) &&
  has('ffprobe', ['-version']) &&
  has(process.env.FFSUBSYNC ?? 'ffsubsync', ['--version']) &&
  has(process.env.BSDTAR ?? 'bsdtar', ['--version']);
if (!TOOLS)
  console.warn(
    'e2e-flow.test.ts SKIPPED: ffmpeg, ffprobe, ffsubsync or bsdtar not found here. Run `pnpm test:image test/e2e-flow.test.ts`.',
  );
const ASR = !!process.env.ASR_PYTHON;

/** Charade (YTS id 2, IMDb tt9000002 in the fake catalogue): its 1080p x264 version is clip.mp4. */
const YTS_ID = 2;
const IMDB = 'tt9000002';
const FILE_NAME = 'Charade.1963.1080p.zh-TW.mkv';
// Away from `pnpm dev`'s ports (51801, 51811, 51812) and from torrent-worker.test.ts's (52000-57000).
const port = () => 58_000 + Math.floor(Math.random() * 3000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let dataDir: string;
let yts: FakeYts;
let seeder: Seeder;
let sources: FakeSources;
let engine: Engine;
let worker: TorrentWorker;
let media: MediaService;
let driver: ReturnType<typeof setInterval> | undefined;
let mei: string;
let clipHash: string;

/**
 * The torrent loop and the media service's reconciliation, as their programs run them (every 2 s
 * and on NOTIFY there; more often here). A pass never overlaps the previous one.
 */
function drive(): void {
  let running = false;
  driver = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await worker.tick();
        await media.reconcile();
      } finally {
        running = false;
      }
    })();
  }, 250);
}

async function until(what: string, check: () => Promise<boolean>, ms = 120_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await sleep(200);
  }
  throw new Error(`${what}: not reached in ${ms / 1000} s`);
}

const get = async (url: string) => {
  const res = await call(t.app, 'GET', url, { cookie: mei });
  if (res.statusCode !== 200) throw new Error(`GET ${url}: ${res.statusCode} ${res.body}`);
  return res.json();
};

function upload(torrentId: string, name: string, content: Buffer) {
  const boundary = `----paiban${Math.random().toString(16).slice(2)}`;
  return t.app.inject({
    method: 'POST',
    url: `/api/torrents/${torrentId}/uploads`,
    headers: {
      cookie: mei,
      'x-requested-with': 'paiban',
      origin: PUBLIC_URL,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

/** Every file under the data folder, relative to it. Empty folders are nobody's files. */
async function filesOnDisk(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(join(dataDir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p);
      else out.push(p);
    }
  };
  await walk('');
  return out.sort();
}

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
/** Start and duration of every packet of one subtitle stream. */
const cueTimes = (file: string, streamIndex: number): [number, number][] =>
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

describe.skipIf(!TOOLS)('the whole flow, offline', { timeout: 240_000 }, () => {
  // What the steps hand each other.
  let torrentId = '';
  let mediaId = '';
  let zh: { id: string; cues: Cue[]; doc: SyncDoc } = { id: '', cues: [], doc: SyncCore.identityDoc() };
  let en: { id: string; cues: Cue[]; doc: SyncDoc } = { id: '', cues: [], doc: SyncCore.identityDoc() };
  let exportId = '';
  let mkv: Buffer = Buffer.alloc(0);

  beforeAll(async () => {
    db = await testDb();
    sources = await startFakeSources({ answerAsInception: [IMDB] });
    t = await testApp(db.pool, { sourceOverrides: sources.overrides });
    dataDir = t.deps.config.dataDir;
    seeder = await startSeeder([fixture('clip.mp4')], port());
    const clip = seeder.seeded[0];
    if (!clip) throw new Error('nothing seeded');
    clipHash = clip.hash;
    yts = await startFakeYts({
      local: [
        {
          ytsId: YTS_ID,
          quality: '1080p',
          type: 'bluray',
          videoCodec: 'x264',
          bitDepth: 8,
          audio: '2.0',
          hash: clip.hash,
          sizeBytes: clip.length,
        },
      ],
    });
    await setSetting(db.pool, 'yts.baseUrl', yts.url);
    await setLimit(db.pool, 20 * GB);
    // Without a recogniser the flow is the same minus `heard`; switched off, nothing waits for it.
    if (!ASR) await setSetting(db.pool, 'align.asr', false);
    await createUser(db.pool, 'mei');
    await createUser(db.pool, 'boss', 'admin');
    mei = await login(t.app, 'mei');
    // JustSubtitles finds a film by its TMDB id, which needs a TMDB key (a fake one; the fake TMDB takes any).
    const boss = await login(t.app, 'boss');
    const key = await call(t.app, 'PUT', '/api/admin/secrets/tmdbKey', {
      cookie: boss,
      body: { value: 'tmdb-test-key-not-real' },
    });
    expect(key.statusCode).toBe(204);

    engine = createEngine({ torrentPort: port(), dhtPort: port(), downloadLimit: 0, uploadLimit: 0, offline: true });
    worker = new TorrentWorker({
      pool: db.pool,
      config: { ...t.deps.config, torrentTestPeers: [`127.0.0.1:${seeder.port}`] },
      log: pino({ level: process.env.TEST_LOG ?? 'silent' }),
      engine,
      disk: t.deps.disk,
    });
    await worker.recover();
    media = new MediaService({
      pool: db.pool,
      config: t.deps.config,
      log: pino({ level: process.env.TEST_LOG ?? 'silent' }),
      disk: t.deps.disk,
    });
    await media.start();
    drive();
  });

  afterAll(async () => {
    if (driver) clearInterval(driver);
    media?.stop();
    await worker?.shutdown().catch(() => undefined);
    await seeder?.close();
    await yts?.close();
    await sources?.close();
    await t?.app.close();
    await db?.drop();
  });

  it('finds the film on YTS and opens it', async () => {
    const found = await get('/api/yts/movies?q=charade');
    expect(found.total).toBe(1);
    expect(found.items[0]).toMatchObject({
      ytsId: YTS_ID,
      imdbCode: IMDB,
      title: 'Charade',
      year: 1963,
      mine: 'none',
      posterUrl: `/api/yts/movies/${YTS_ID}/poster`,
    });
    const movie = await get(`/api/yts/movies/${YTS_ID}`);
    const version = movie.versions.find((v: { infoHash: string }) => v.infoHash === clipHash);
    expect(version).toMatchObject({
      quality: '1080p',
      videoCodec: 'x264',
      bitDepth: 8,
      sizeBytes: seeder.seeded[0]?.length,
      directPlay: true,
      previewBytes: 0,
      local: { kind: 'none', fits: true, shortBytes: 0 },
    });
    expect(movie.stale).toBe(false);
  });

  it('downloads the version from the local seeder, byte for byte', async () => {
    const res = await call(t.app, 'POST', '/api/torrents', {
      cookie: mei,
      body: { ytsId: YTS_ID, infoHash: clipHash.toUpperCase() },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ joined: false, torrent: { infoHash: clipHash, mine: true } });
    torrentId = res.json().torrent.id;
    await until('download completed', async () => (await get(`/api/torrents/${torrentId}`)).progress === 1, 180_000);
    await until('download recorded', async () => (await get(`/api/torrents/${torrentId}`)).media !== null);
    const torrent = await get(`/api/torrents/${torrentId}`);
    expect(['analyzing', 'ready']).toContain(torrent.status);
    expect(torrent.diskBytes).toBeGreaterThan(0);
    mediaId = torrent.media.id;
    const onDisk = await readFile(join(dataDir, 'torrents', clipHash, 'clip.mp4'));
    expect(sha(onDisk)).toBe(sha(await readFile(fixture('clip.mp4'))));
    const notes = (await get('/api/notifications')).items;
    expect(notes).toContainEqual(
      expect.objectContaining({
        kind: 'download.completed',
        data: { movieTitle: 'Charade', version: '1080p BluRay x264' },
        link: { page: 'workspace', torrentId, tab: 'subtitles' },
      }),
    );
    // The film page and the search now say it is the caller's.
    const movie = await get(`/api/yts/movies/${YTS_ID}`);
    expect(movie.versions.find((v: { infoHash: string }) => v.infoHash === clipHash).local).toMatchObject({
      kind: 'present',
      torrentId,
      mine: true,
    });
  }, 200_000);

  it('analyses the film into the fixture’s exact waveform and speech, and recognises speech', async () => {
    await until('analysis ready', async () => (await get(`/api/media/${mediaId}`)).analysis === 'ready');
    const data = JSON.parse(await readFile(fixture('data.json'), 'utf8'));
    expect(await get(`/api/media/${mediaId}/speech`)).toEqual({
      hz: 100,
      frames: data.speechFrames,
      segments: data.speech,
    });
    const peaks = await call(t.app, 'GET', `/api/media/${mediaId}/peaks`, { cookie: mei });
    expect(peaks.rawPayload.equals(Buffer.from(data.peaks, 'base64'))).toBe(true);
    const status = await get(`/api/media/${mediaId}`);
    expect(status).toMatchObject({
      directPlay: true,
      audio: 'none',
      proxy: { state: 'none' },
      errors: {},
      previewBytes: 0,
      sources: [{ kind: 'original', url: `/api/media/${mediaId}/original`, mime: 'video/mp4' }],
    });
    expect(status.durationSeconds).toBeCloseTo(92.37, 1);
    if (ASR) {
      await until('speech recognised', async () =>
        ['ready', 'failed'].includes((await get(`/api/media/${mediaId}`)).asr.state),
      );
      expect((await get(`/api/media/${mediaId}`)).asr).toEqual({ state: 'ready', language: 'en' });
    } else expect(status.asr.state).toBe('none');
    expect((await get(`/api/torrents/${torrentId}`)).status).toBe('ready');
    expect((await get('/api/library'))[0]).toMatchObject({ torrent: { id: torrentId }, next: 'subtitles' });
    expect((await get('/api/yts/movies?q=charade')).items[0].mine).toBe('ready');
  }, 300_000);

  it('searches the subtitle sources: each answers on its own, the one without a token says so', async () => {
    const res = await call(t.app, 'POST', `/api/torrents/${torrentId}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['zh-Hant', 'en'] },
    });
    expect(res.statusCode).toBe(200);
    await t.app.subtitleWorker.idle();
    const list = await get(`/api/torrents/${torrentId}/candidates`);
    const byId = Object.fromEntries(list.providers.map((p: { id: string }) => [p.id, p]));
    expect(byId.justsubtitles).toMatchObject({ state: 'ok', count: 37, error: null });
    expect(byId.yify).toMatchObject({ state: 'ok', count: 157, error: null });
    expect(byId.assrt).toMatchObject({ state: 'error', error: { code: 'NOT_CONFIGURED' } });
    expect(byId.zimuku).toMatchObject({ state: 'manual' });
    expect(list.candidates.length).toBe(37 + 157);
    // No key or query string from a source is kept (AGENTS.md rule 3).
    const stored = (await db.pool.query('select download_url, page_url from subtitle_candidates')).rows;
    expect(JSON.stringify(stored)).not.toMatch(/api_key|tmdb-test-key|\?/);
  });

  it('adds an uploaded subtitle and a source’s archive, one candidate per file, without duplicates', async () => {
    const up = await upload(torrentId, 'late.zh-TW.srt', await readFile(fixture('late.zh-TW.srt')));
    expect(up.statusCode).toBe(200);
    type C = { id: string; provider: string; language: string; releaseName: string; fetch: string };
    const candidates = async (): Promise<C[]> => (await get(`/api/torrents/${torrentId}/candidates`)).candidates;
    let mine: C | undefined;
    await until('upload processed', async () => {
      mine = (await candidates()).find((c) => c.provider === 'upload');
      return mine?.fetch === 'ready';
    });
    expect(mine).toMatchObject({ language: 'zh-Hant', releaseName: 'late.zh-TW.srt' });
    const added = await call(t.app, 'POST', `/api/candidates/${mine?.id}/add`, { cookie: mei, body: {} });
    expect(added.statusCode).toBe(200);
    expect(added.json()).toMatchObject({ language: 'zh-Hant', cueCount: 26, status: 'draft', rev: 0 });
    zh = { id: added.json().id, cues: [], doc: SyncCore.identityDoc() };

    // A JustSubtitles result: archive.zip holds the same Big5 Traditional subtitle and an English one.
    const pick = (await candidates()).find((c) => c.provider === 'justsubtitles' && c.fetch === 'new') as C;
    const dup = await call(t.app, 'POST', `/api/candidates/${pick.id}/add`, { cookie: mei, body: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('SUBTITLE_DUPLICATE');
    expect(sources.requests.some((r) => r.source === 'subdl-dl' && !r.path.includes('?'))).toBe(true);
    const fromZip = (await candidates()).filter((c) => c.provider === 'justsubtitles' && c.fetch === 'ready');
    expect(fromZip.map((c) => c.language).sort()).toEqual(['en', 'zh-Hant']);
    const english = fromZip.find((c) => c.language === 'en') as C;
    const second = await call(t.app, 'POST', `/api/candidates/${english.id}/add`, { cookie: mei, body: {} });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ language: 'en', cueCount: 26, status: 'draft' });
    en = { id: second.json().id, cues: [], doc: SyncCore.identityDoc() };
    const listed = await get(`/api/torrents/${torrentId}/subtitles`);
    expect(listed.map((s: { id: string }) => s.id).sort()).toEqual([zh.id, en.id].sort());
    expect((await get('/api/library'))[0].next).toBe('sync');
  });

  it('auto-aligns the late subtitle to the speech and saves the result as a revision', async () => {
    const res = await call(t.app, 'POST', `/api/subtitles/${zh.id}/auto-align`, {
      cookie: mei,
      body: { allowSplit: true },
    });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    // docs/08-media-pipeline.md, "在測試素材上的結果": late is one segment at -2.36 s, both engines agree.
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0].scale).toBe(1);
    expect(Math.abs(r.segments[0].offset - -2.36)).toBeLessThanOrEqual(0.01);
    expect(r.agree).toBe(true);
    expect(r.score).toBeGreaterThan(r.scoreBefore);
    if (ASR) expect(r.heard).toMatchObject({ language: 'en' });
    else expect(r.heard).toBeNull();
    // Auto-align answers; it does not touch the stored document.
    const before = await get(`/api/subtitles/${zh.id}`);
    expect(before.subtitle.rev).toBe(0);

    const saved = await call(t.app, 'PUT', `/api/subtitles/${zh.id}/doc`, {
      cookie: mei,
      body: { rev: 0, doc: { ...before.doc, segments: r.segments }, reason: 'auto-align' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ rev: 1, status: 'draft' });
    expect(saved.json().score).toBeGreaterThan(0.75);
    const revs = (await db.pool.query('select rev, reason from subtitle_revisions where subtitle_id = $1', [zh.id]))
      .rows;
    expect(revs).toEqual([{ rev: 1, reason: 'auto-align' }]);

    // The aligned lines land on the truth (late = truth + 2.4 s): within 0.1 s, every one.
    const after = await get(`/api/subtitles/${zh.id}`);
    zh = { id: zh.id, cues: after.cues, doc: after.doc };
    const truth = parseSrt(await readFile(fixture('truth.zh-TW.srt'), 'utf8'));
    const aligned = SyncCore.applyDoc(zh.cues, zh.doc);
    expect(aligned).toHaveLength(truth.length);
    for (const [i, c] of aligned.entries()) expect(Math.abs(c.start - (truth[i]?.start ?? 0))).toBeLessThan(0.1);
  });

  it('auto-aligns the English one (already right) and, with recognition, pairs it by text', async () => {
    const res = await call(t.app, 'POST', `/api/subtitles/${en.id}/auto-align`, {
      cookie: mei,
      body: { allowSplit: true },
    });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.segments).toHaveLength(1);
    expect(Math.abs(r.segments[0].offset)).toBeLessThan(0.1);
    expect(Math.abs(r.segments[0].scale - 1)).toBeLessThan(0.001);
    if (ASR) {
      expect(r.heard).toMatchObject({ language: 'en', via: 'text', llmError: null });
      expect(r.heard.pairs).toBeGreaterThanOrEqual(5);
    } else expect(r.heard).toBeNull();
    const cur = await get(`/api/subtitles/${en.id}`);
    const saved = await call(t.app, 'PUT', `/api/subtitles/${en.id}/doc`, {
      cookie: mei,
      body: { rev: cur.subtitle.rev, doc: { ...cur.doc, segments: r.segments }, reason: 'auto-align' },
    });
    expect(saved.statusCode).toBe(200);
    const after = await get(`/api/subtitles/${en.id}`);
    en = { id: en.id, cues: after.cues, doc: after.doc };
  });

  it('confirms: one after passing every checkpoint, the other with `force`', async () => {
    const cur = await get(`/api/subtitles/${zh.id}`);
    expect(cur.doc.checkpoints.length).toBeGreaterThan(0);
    const early = await call(t.app, 'POST', `/api/subtitles/${zh.id}/confirm`, {
      cookie: mei,
      body: { rev: cur.subtitle.rev },
    });
    expect(early.statusCode).toBe(422);
    expect(early.json().error.details).toEqual({ fields: { force: 'CHECKPOINTS_PENDING' } });
    const passed = {
      ...cur.doc,
      checkpoints: cur.doc.checkpoints.map((c: object) => ({ ...c, status: 'ok' })),
    };
    const marked = await call(t.app, 'PUT', `/api/subtitles/${zh.id}/doc`, {
      cookie: mei,
      body: { rev: cur.subtitle.rev, doc: passed },
    });
    expect(marked.statusCode).toBe(200);
    const ok = await call(t.app, 'POST', `/api/subtitles/${zh.id}/confirm`, {
      cookie: mei,
      body: { rev: marked.json().rev },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'confirmed', confirmedBy: { displayName: 'mei' } });

    const enCur = await get(`/api/subtitles/${en.id}`);
    const forced = await call(t.app, 'POST', `/api/subtitles/${en.id}/confirm`, {
      cookie: mei,
      body: { rev: enCur.subtitle.rev, force: true },
    });
    expect(forced.json()).toMatchObject({ status: 'confirmed' });
    zh.doc = (await get(`/api/subtitles/${zh.id}`)).doc;
    en.doc = (await get(`/api/subtitles/${en.id}`)).doc;
    expect((await get('/api/library'))[0]).toMatchObject({
      subtitles: { total: 2, confirmed: 2, draft: 0 },
      next: 'export',
    });
  });

  it('exports an MKV with both tracks, Traditional Chinese first and default', async () => {
    const res = await call(t.app, 'POST', `/api/torrents/${torrentId}/exports`, {
      cookie: mei,
      body: {
        fileName: FILE_NAME,
        tracks: [
          { subtitleId: en.id, isDefault: false },
          { subtitleId: zh.id, isDefault: true },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      torrentId,
      fileName: FILE_NAME,
      state: 'queued',
      tracks: [
        { language: 'zh-Hant', title: '繁體中文', isDefault: true },
        { language: 'en', title: 'English', isDefault: false },
      ],
    });
    exportId = res.json().id;
    await until('export done', async () => {
      const e = (await get('/api/exports')).find((x: { id: string }) => x.id === exportId);
      return e?.state === 'done' || e?.state === 'failed';
    });
    // The notification is the job's last step.
    await until('export notified', async () =>
      (await get('/api/notifications')).items.some((n: { kind: string }) => n.kind.startsWith('export.')),
    );
    const e = (await get('/api/exports')).find((x: { id: string }) => x.id === exportId);
    expect(e).toMatchObject({
      state: 'done',
      progress: 1,
      errorCode: null,
      downloadUrl: `/api/exports/${exportId}/file`,
      canDelete: true,
    });
    expect((await get('/api/notifications')).items).toContainEqual(
      expect.objectContaining({
        kind: 'export.completed',
        data: expect.objectContaining({ fileName: FILE_NAME }),
        link: { page: 'workspace', torrentId, tab: 'export' },
      }),
    );
    // Only the MKV is left in its folder: the tracks it was made from are gone.
    expect(await readdir(join(dataDir, 'exports', exportId))).toEqual([FILE_NAME]);
    const workspace = await get(`/api/library/${torrentId}`);
    expect(workspace.exports.map((x: { id: string }) => x.id)).toEqual([exportId]);
    expect(workspace.item).toMatchObject({ exports: 1, next: 'exported' });
    const usage = (await get('/api/storage')).usage;
    expect(usage.categories.exports).toBe(e.sizeBytes);
    expect(usage.categories.reserved).toBe(0);
  });

  it('downloads the MKV in two ranges; it holds the video, the audio and both tracks, as asked', async () => {
    const url = `/api/exports/${exportId}/file`;
    const head = await call(t.app, 'GET', url, { cookie: mei, headers: { range: 'bytes=0-65535' } });
    expect(head.statusCode).toBe(206);
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.headers['content-type']).toContain('video/x-matroska');
    expect(String(head.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(String(head.headers['content-disposition'])).toContain(`filename*=UTF-8''${FILE_NAME}`);
    const total = Number(/\/(\d+)$/.exec(String(head.headers['content-range']))?.[1]);
    expect(head.headers['content-range']).toBe(`bytes 0-65535/${total}`);
    const tail = await call(t.app, 'GET', url, { cookie: mei, headers: { range: 'bytes=65536-' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.headers['content-range']).toBe(`bytes 65536-${total - 1}/${total}`);
    mkv = Buffer.concat([head.rawPayload, tail.rawPayload]);
    expect(mkv.length).toBe(total);
    expect(mkv.equals(await readFile(join(dataDir, 'exports', exportId, FILE_NAME)))).toBe(true);

    const file = join(await mkdtemp(join(tmpdir(), 'paiban-e2e-')), FILE_NAME);
    await writeFile(file, mkv);
    const p = probe(file);
    expect(p.format.tags?.title).toBe('Charade (1963)');
    expect(p.streams.map((s) => [s.codec_type, s.codec_name])).toEqual([
      ['video', 'h264'],
      ['audio', 'aac'],
      ['subtitle', 'subrip'],
      ['subtitle', 'subrip'],
    ]);
    const subs = p.streams.filter((s) => s.codec_type === 'subtitle');
    expect(subs.map((s) => [s.tags?.language, s.tags?.title, s.disposition?.default])).toEqual([
      ['chi', '繁體中文', 1],
      ['eng', 'English', 0],
    ]);
    // Each track's times are its saved sync applied, moved only by the container's common offset.
    const wantZh = SyncCore.applyDoc(zh.cues, zh.doc).filter((c) => !c.deleted);
    const gotZh = cueTimes(file, subs[0]?.index ?? -1);
    const shift = (gotZh[0]?.[0] ?? 0) - (wantZh[0]?.start ?? 0);
    expect(Math.abs(shift)).toBeLessThan(0.1);
    for (const [k, s] of [zh, en].entries()) {
      const want = SyncCore.applyDoc(s.cues, s.doc).filter((c) => !c.deleted);
      const got = cueTimes(file, subs[k]?.index ?? -1);
      expect(got).toHaveLength(want.length);
      for (const [i, c] of want.entries()) {
        expect(got[i]?.[0]).toBeCloseTo(c.start + shift, 2);
        expect(got[i]?.[1]).toBeCloseTo(c.end - c.start, 2);
      }
    }
  });

  it('removing the film deletes it with its analysis and subtitles, and leaves the export downloadable', async () => {
    const before = await filesOnDisk();
    expect(before).toEqual(
      expect.arrayContaining([
        `torrents/${clipHash}/clip.mp4`,
        `media/${mediaId}/speech.json`,
        `subtitles/${zh.id}/cues.json`,
        `subtitles/${en.id}/cues.json`,
        `exports/${exportId}/${FILE_NAME}`,
      ]),
    );
    const res = await call(t.app, 'DELETE', `/api/torrents/${torrentId}/hold`, { cookie: mei });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(res.json().freedBytes).toBeGreaterThanOrEqual(seeder.seeded[0]?.length ?? 0);
    await until(
      'film removed',
      async () => (await db.pool.query('select 1 from torrents where id = $1', [torrentId])).rowCount === 0,
    );
    // Only the export is left; the film, its analysis, subtitles and candidates went with it.
    expect(await filesOnDisk()).toEqual([`exports/${exportId}/${FILE_NAME}`]);
    for (const table of ['media_files', 'subtitles', 'subtitle_candidates', 'movies'])
      expect((await db.pool.query(`select count(*)::int as n from ${table}`)).rows[0].n, table).toBe(0);
    expect(await get('/api/library')).toEqual([]);
    // docs/10-storage.md: "最後一位持有人移除電影：匯出檔還在、還能下載".
    const e = (await get('/api/exports')).find((x: { id: string }) => x.id === exportId);
    expect(e).toMatchObject({ state: 'done', torrentId: null });
    const again = await call(t.app, 'GET', `/api/exports/${exportId}/file`, { cookie: mei });
    expect(again.statusCode).toBe(200);
    expect(sha(again.rawPayload)).toBe(sha(mkv));
  });

  it('deleting the export frees its size and leaves nothing on disk', async () => {
    const res = await call(t.app, 'DELETE', `/api/exports/${exportId}`, { cookie: mei });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ freedBytes: mkv.length });
    expect(await filesOnDisk()).toEqual([]);
    expect(await get('/api/exports')).toEqual([]);
    const usage = (await get('/api/storage')).usage;
    expect(usage.usedBytes).toBe(0);
    expect(Object.values(usage.categories).every((n) => n === 0)).toBe(true);
    const busy = (await db.pool.query(`select kind from tasks where state in ('queued', 'running')`)).rows;
    expect(busy).toEqual([]);
    const actions = (await db.pool.query('select action from audit_log order by id')).rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining(['torrent.add', 'subtitle.add', 'export.create', 'torrent.delete', 'export.delete']),
    );
  });
});
