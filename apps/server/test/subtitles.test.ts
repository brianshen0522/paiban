import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FakeSources, startFakeSources } from '@paiban/fakes/subtitles';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MediaService } from '../src/media/service.js';
import { SubtitleWorker } from '../src/subtitles/worker.js';
import { call, createUser, login, PUBLIC_URL, type TestApp, testApp, testDb } from './helpers.js';

/**
 * The subtitle endpoints end to end (docs/04-api.md "字幕", docs/07, docs/09 "儲存", "確認"): the
 * api's worker against the fake sources, the media service processing what it staged. Archives
 * need bsdtar and full alignment needs ffsubsync: those cases run in the image (`pnpm test:image`)
 * and are skipped here, loudly. Without ffsubsync the core engine still aligns.
 */
const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
const BSDTAR = has(process.env.BSDTAR ?? 'bsdtar', ['--version']);
const FFSUBSYNC = has(process.env.FFSUBSYNC ?? 'ffsubsync', ['--version']);
if (!BSDTAR || !FFSUBSYNC)
  console.warn(
    `subtitles.test.ts: ${[!BSDTAR && 'bsdtar', !FFSUBSYNC && 'ffsubsync'].filter(Boolean).join(' and ')} not found here; the cases that need them are SKIPPED. Run \`pnpm test:image\`.`,
  );

const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let fake: FakeSources;
let media: MediaService;
let mei: string;
let meiId: string;
let kai: string;
let boss: string;
let inception: { tid: string; mid: string };
let sample: { tid: string; mid: string };
let n = 0;

async function until(check: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await media.reconcile();
    await sleep(100);
  }
  throw new Error('condition not met in time');
}

/** A finished film; with `speech`, analysed (speech.json and ref.npz from the fixtures). */
async function film(title: string, imdb: string, year: number, opts: { speech?: boolean; holders?: string[] } = {}) {
  n++;
  const movie = (
    await db.pool.query(
      `insert into movies (yts_id, imdb_code, title, year, runtime_min) values ($1, $2, $3, $4, 2) returning id`,
      [5000 + n, imdb, title, year],
    )
  ).rows[0].id;
  const tid = (
    await db.pool.query(
      `insert into torrents (info_hash, movie_id, quality, source_type, video_codec, size_bytes, state, disk_bytes)
       values ($1, $2, '1080p', 'bluray', 'x264', 1000, 'completed', 1000) returning id`,
      [(0xdef000 + n).toString(16).padStart(40, '0'), movie],
    )
  ).rows[0].id;
  for (const u of opts.holders ?? [meiId])
    await db.pool.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [tid, u]);
  const mid = (
    await db.pool.query(
      `insert into media_files (torrent_id, rel_path, size_bytes, direct_play, probe_state, analysis_state)
       values ($1, 'clip.mp4', 1000, true, 'ready', $2) returning id`,
      [tid, opts.speech ? 'ready' : 'none'],
    )
  ).rows[0].id;
  if (opts.speech) {
    const dir = join(t.deps.config.dataDir, 'media', mid);
    await mkdir(dir, { recursive: true });
    const data = JSON.parse(await readFile(fixture('data.json'), 'utf8'));
    await writeFile(
      join(dir, 'speech.json'),
      JSON.stringify({ hz: 100, frames: data.speechFrames, segments: data.speech }),
    );
    await copyFile(fixture('clip.npz'), join(dir, 'ref.npz'));
  }
  return { tid, mid };
}

function upload(app: FastifyInstance, torrentId: string, name: string, content: Buffer, cookie = mei) {
  const boundary = `----paiban${Math.random().toString(16).slice(2)}`;
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/torrents/${torrentId}/uploads`,
    headers: {
      cookie,
      'x-requested-with': 'paiban',
      origin: PUBLIC_URL,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
}

type CandidateJson = {
  id: string;
  provider: string;
  language: string;
  languageLabel: string;
  releaseName: string;
  fetch: string;
  fetchError: string | null;
  flags: Record<string, unknown>;
  align: { state: string; score: number | null };
  recommended: boolean;
  added: boolean;
};
const candidates = async (tid: string): Promise<CandidateJson[]> =>
  (await call(t.app, 'GET', `/api/torrents/${tid}/candidates`, { cookie: mei })).json().candidates;
const providers = async (tid: string) =>
  Object.fromEntries(
    (await call(t.app, 'GET', `/api/torrents/${tid}/candidates`, { cookie: mei }))
      .json()
      .providers.map((p: { id: string }) => [p.id, p]),
  );

/** Uploads a fixture and waits until the media service processed it. */
async function uploaded(tid: string, file: string, name = file): Promise<CandidateJson> {
  const res = await upload(t.app, tid, name, await readFile(fixture(file)));
  expect(res.statusCode).toBe(200);
  let found: CandidateJson | undefined;
  await until(async () => {
    found = (await candidates(tid)).find((c) => c.provider === 'upload' && c.releaseName === name);
    return !!found && found.fetch !== 'fetching';
  });
  return found as CandidateJson;
}

beforeAll(async () => {
  db = await testDb();
  fake = await startFakeSources();
  t = await testApp(db.pool, { sourceOverrides: fake.overrides });
  meiId = await createUser(db.pool, 'mei');
  const kaiId = await createUser(db.pool, 'kai');
  await createUser(db.pool, 'boss', 'admin');
  mei = await login(t.app, 'mei');
  kai = await login(t.app, 'kai');
  boss = await login(t.app, 'boss');
  inception = await film('Inception', 'tt1375666', 2010, { speech: true, holders: [meiId, kaiId] });
  sample = await film('Sample Movie', 'tt0000002', 2010, { speech: true });
  media = new MediaService({ pool: db.pool, config: t.deps.config, log: pino({ level: 'silent' }), disk: t.deps.disk });
  await media.start();
});
afterAll(async () => {
  media?.stop();
  await t?.app.close();
  await fake?.close();
  await db?.drop();
});
beforeEach(() => {
  fake.reset();
});

describe('keys (docs/13-settings.md, "金鑰")', () => {
  it('are written by administrators only, stored encrypted, reported as set, and never returned', async () => {
    expect(
      (await call(t.app, 'PUT', '/api/admin/secrets/tmdbKey', { cookie: mei, body: { value: 'x' } })).statusCode,
    ).toBe(403);
    const res = await call(t.app, 'PUT', '/api/admin/secrets/tmdbKey', {
      cookie: boss,
      body: { value: 'tmdb-test-key-not-real' },
    });
    expect(res.statusCode).toBe(204);
    const row = (await db.pool.query(`select nonce, ciphertext from secrets where name = 'tmdbKey'`)).rows[0];
    expect(row.nonce.length).toBe(12);
    expect(row.ciphertext.toString('latin1')).not.toContain('tmdb-test-key');
    const settings = (await call(t.app, 'GET', '/api/admin/settings', { cookie: boss })).json();
    expect(settings.info.secrets).toEqual({ tmdbKey: true, subdlKey: false, assrtToken: false, llmKey: false });
    expect(JSON.stringify(settings)).not.toContain('tmdb-test-key');
    expect(
      (await call(t.app, 'PUT', '/api/admin/secrets/nope', { cookie: boss, body: { value: 'x' } })).statusCode,
    ).toBe(422);
    expect(
      (await call(t.app, 'PUT', '/api/admin/secrets/subdlKey', { cookie: boss, body: { value: '  ' } })).statusCode,
    ).toBe(422);
    await call(t.app, 'PUT', '/api/admin/secrets/subdlKey', {
      cookie: boss,
      body: { value: 'subdl-test-key-not-real' },
    });
    expect((await call(t.app, 'DELETE', '/api/admin/secrets/subdlKey', { cookie: boss })).statusCode).toBe(204);
    const audit = (
      await db.pool.query(`select action, target::text from audit_log where action like 'admin.secret.%' order by id`)
    ).rows;
    expect(audit.map((a) => a.action)).toEqual(['admin.secret.set', 'admin.secret.set', 'admin.secret.clear']);
    expect(JSON.stringify(audit)).not.toContain('not-real');
  });

  it('test a source with the stored key (POST /api/admin/sources/:id/test)', async () => {
    const res = await call(t.app, 'POST', '/api/admin/sources/tmdb/test', { cookie: boss });
    expect(res.json()).toMatchObject({ ok: true, code: 'OK' });
    expect(fake.requests[0]?.path).toContain('api_key=tmdb-test-key-not-real');
    expect((await call(t.app, 'POST', '/api/admin/sources/subdl/test', { cookie: boss })).json()).toMatchObject({
      ok: false,
      code: 'NOT_CONFIGURED',
    });
    const health = (await call(t.app, 'GET', '/api/admin/settings', { cookie: boss })).json().sources;
    expect(health.find((s: { id: string }) => s.id === 'subdl')).toMatchObject({
      state: 'warn',
      code: 'NOT_CONFIGURED',
    });
  });
});

describe('searching (docs/07)', () => {
  it('answers with what it started, even for a source that has nothing to ask and finishes at once', async () => {
    // 射手網 without a token fails without a request; it used to be able to finish before the answer
    // was read, and the answer then said "error" where it should say "running" (seen under load).
    for (let i = 0; i < 20; i++) {
      const r = await call(t.app, 'POST', `/api/torrents/${inception.tid}/subtitle-search`, {
        cookie: mei,
        body: { languages: ['en'], provider: 'assrt' },
      });
      expect(r.json().providers.find((p: { id: string }) => p.id === 'assrt').state).toBe('running');
      await t.app.subtitleWorker.idle();
    }
  });

  it('answers at once with every source running, then fills in each one on its own', async () => {
    const res = await call(t.app, 'POST', `/api/torrents/${inception.tid}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['zh-Hant', 'en'] },
    });
    expect(res.statusCode).toBe(200);
    const first = res.json();
    expect(first.providers.map((p: { id: string; state: string }) => `${p.id}:${p.state}`)).toEqual([
      'justsubtitles:running',
      'yify:running',
      'assrt:running',
      'zimuku:manual',
    ]);
    expect(first.providers.find((p: { id: string }) => p.id === 'assrt').credit).toEqual({
      name: 'assrt.net',
      url: 'https://assrt.net',
    });
    await t.app.subtitleWorker.idle();
    const p = await providers(inception.tid);
    expect(p.justsubtitles).toMatchObject({ state: 'ok', count: 37, error: null });
    expect(p.yify).toMatchObject({ state: 'ok', count: 157 });
    // No token: this source says so; the others are not affected.
    expect(p.assrt).toMatchObject({ state: 'error', error: { code: 'NOT_CONFIGURED', retryAt: null } });
    const list = await candidates(inception.tid);
    expect(list.length).toBe(37 + 157);
    // Traditional first, then the version match: a YIFY 1080p BluRay release leads.
    expect(list[0]?.language).not.toBe('en');
    const stored = (await db.pool.query('select download_url, page_url from subtitle_candidates')).rows;
    expect(JSON.stringify(stored)).not.toMatch(/api_key|PLACEHOLDER|\?/);
    expect((await db.pool.query(`select tmdb_id, title_zh from movies where imdb_code = 'tt1375666'`)).rows[0]).toEqual(
      {
        tmdb_id: 27205,
        title_zh: '全面啟動',
      },
    );
  });

  it('uses the cache unless asked to refresh, and keeps one source’s failure to itself', async () => {
    await call(t.app, 'POST', `/api/torrents/${inception.tid}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['zh-Hant', 'en'], provider: 'justsubtitles' },
    });
    await t.app.subtitleWorker.idle();
    expect(fake.requests.filter((r) => r.source === 'justsubtitles')).toEqual([]);
    fake.setMode('yify', 'error500');
    await call(t.app, 'POST', `/api/torrents/${inception.tid}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['zh-Hant', 'en'], refresh: true },
    });
    await t.app.subtitleWorker.idle();
    const p = await providers(inception.tid);
    expect(p.yify).toMatchObject({ state: 'error', error: { code: 'UNREACHABLE' } });
    expect(p.justsubtitles).toMatchObject({ state: 'ok', count: 37 });
    expect(fake.requests.filter((r) => r.source === 'justsubtitles').length).toBe(3);
    // The failed source's earlier results that were never fetched stay until it answers again.
    expect((await candidates(inception.tid)).filter((c) => c.provider === 'yify').length).toBe(157);
  });

  it('shows 0 results, not an error, for a film JustSubtitles does not know', async () => {
    const f = await film('Unknown', 'tt0000099', 2001);
    await db.pool.query(`update movies set tmdb_id = 999999999 where imdb_code = 'tt0000099'`);
    await call(t.app, 'POST', `/api/torrents/${f.tid}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['en'], provider: 'justsubtitles' },
    });
    await t.app.subtitleWorker.idle();
    expect((await providers(f.tid)).justsubtitles).toMatchObject({ state: 'ok', count: 0, error: null });
  });

  it('射手網 over its limit: RATE_LIMITED with the time it will try again, and no request meanwhile', async () => {
    await call(t.app, 'PUT', '/api/admin/secrets/assrtToken', {
      cookie: boss,
      body: { value: 'assrt-test-token-not-real' },
    });
    await db.pool.query('delete from provider_slots');
    fake.setMode('assrt', 'ratelimit-once');
    const before = Date.now();
    await call(t.app, 'POST', `/api/torrents/${sample.tid}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['zh-Hant'], provider: 'assrt' },
    });
    await t.app.subtitleWorker.idle();
    const p = (await providers(sample.tid)).assrt;
    expect(p.state).toBe('error');
    expect(p.error.code).toBe('RATE_LIMITED');
    const wait = Date.parse(p.error.retryAt) - before;
    expect(wait).toBeGreaterThan(55_000);
    expect(wait).toBeLessThan(66_000);
    await sleep(500);
    expect(fake.requests.filter((r) => r.source === 'assrt').length).toBe(1);
    const health = (await db.pool.query(`select state, code from source_health where source = 'assrt'`)).rows[0];
    expect(health).toEqual({ state: 'warn', code: 'RATE_LIMITED' });
    // The person presses "重試": a fresh search once the slot frees up (pacing waits, it does not hammer).
    await db.pool.query('delete from provider_slots');
    await call(t.app, 'POST', `/api/torrents/${sample.tid}/subtitle-search`, {
      cookie: mei,
      body: { languages: ['zh-Hant'], provider: 'assrt', refresh: true },
    });
    await t.app.subtitleWorker.idle();
    expect((await providers(sample.tid)).assrt).toMatchObject({ state: 'ok', count: 2 });
  });

  it('a search left running by a restarted api is picked up by the next one', async () => {
    await db.pool.query(
      `insert into subtitle_searches (torrent_id, provider, state, languages) values ($1, 'justsubtitles', 'running', '{en}')
       on conflict (torrent_id, provider) do update set state = 'running', started_at = now()`,
      [sample.tid],
    );
    const fresh = new SubtitleWorker(t.deps);
    await fresh.start();
    await sleep(50);
    await fresh.idle();
    fresh.stop();
    expect((await providers(sample.tid)).justsubtitles.state).not.toBe('running');
  });
});

describe('uploads (docs/07, "上傳")', () => {
  it('become a candidate at once and are processed into cues: Big5 recognised, language from content', async () => {
    const c = await uploaded(sample.tid, 'late.zh-TW.big5.srt');
    expect(c).toMatchObject({
      fetch: 'ready',
      fetchError: null,
      language: 'zh-Hant',
      flags: expect.objectContaining({ convertedFrom: 'big5', archive: false }),
    });
    const row = (await db.pool.query('select rel_dir, cue_count, bytes from subtitle_candidates where id = $1', [c.id]))
      .rows[0];
    expect(row.cue_count).toBe(26);
    expect((await readdir(join(t.deps.config.dataDir, row.rel_dir))).sort()).toEqual(['cues.json', 'original.srt']);
    // The staged upload goes once the job that used it has ended.
    await until(async () => (await readdir(join(t.deps.config.dataDir, 'tmp', 'uploads'))).length === 0);
    // The same file again: no second row.
    await upload(t.app, sample.tid, 'again.srt', await readFile(fixture('late.zh-TW.big5.srt')));
    await media.reconcile();
    expect((await candidates(sample.tid)).filter((x) => x.provider === 'upload').length).toBe(1);
  });

  it('a file that cannot be read stays as a failed row with its reason, can be removed, and leaves nothing', async () => {
    const res = await upload(t.app, sample.tid, 'blank.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n   \n'));
    expect(res.statusCode).toBe(200);
    let bad: CandidateJson | undefined;
    await until(async () => {
      bad = (await candidates(sample.tid)).find((x) => x.releaseName === 'blank.srt');
      return bad?.fetch === 'failed';
    });
    expect(bad?.fetchError).toBe('PARSE_FAILED');
    const add = await call(t.app, 'POST', `/api/candidates/${bad?.id}/add`, { cookie: mei, body: {} });
    expect(add.statusCode).toBe(422);
    expect(add.json().error).toMatchObject({ code: 'CANDIDATE_UNAVAILABLE', details: { reason: 'PARSE_FAILED' } });
    expect((await call(t.app, 'DELETE', `/api/candidates/${bad?.id}`, { cookie: mei })).statusCode).toBe(204);
    expect((await candidates(sample.tid)).some((x) => x.releaseName === 'blank.srt')).toBe(false);
    expect(await readdir(join(t.deps.config.dataDir, 'subtitles', 'candidates'))).not.toContain(bad?.id);
    const audit = (await db.pool.query(`select target from audit_log where action = 'subtitle.candidate.remove'`)).rows;
    expect(audit).toEqual([{ target: { movieTitle: 'Sample Movie', releaseName: 'blank.srt' } }]);
  });

  it('refuses other file types and files over 20 MB', async () => {
    const txt = await upload(t.app, sample.tid, 'notes.txt', Buffer.from('hello'));
    expect(txt.statusCode).toBe(415);
    expect(txt.json().error.code).toBe('UNSUPPORTED_FILE');
    const big = await upload(t.app, sample.tid, 'big.srt', Buffer.alloc(20 * 1024 * 1024 + 10, 0x41));
    expect(big.statusCode).toBe(413);
    expect(big.json().error.code).toBe('UPLOAD_TOO_LARGE');
    expect(await readdir(join(t.deps.config.dataDir, 'tmp', 'uploads'))).toEqual([]);
  });
});

describe('adding (docs/07, "加入")', () => {
  let added: { id: string; rev: number };
  let spare: { id: string; torrentId: string };

  it('copies the candidate into a subtitle with checkpoints and a score, once', async () => {
    const c = (await candidates(sample.tid)).find(
      (x) => x.provider === 'upload' && x.fetch === 'ready',
    ) as CandidateJson;
    const res = await call(t.app, 'POST', `/api/candidates/${c.id}/add`, { cookie: mei, body: {} });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s).toMatchObject({
      language: 'zh-Hant',
      format: 'srt',
      cueCount: 26,
      status: 'draft',
      rev: 0,
      convertedToTraditional: false,
    });
    expect(s.score).toBeGreaterThan(0.4);
    added = s;
    const detail = (await call(t.app, 'GET', `/api/subtitles/${s.id}`, { cookie: mei })).json();
    expect(detail.doc.segments).toEqual([{ from: 0, scale: 1, offset: 0 }]);
    expect(detail.doc.checkpoints.length).toBe(8);
    expect(detail.cues.length).toBe(26);
    expect((await readdir(join(t.deps.config.dataDir, 'subtitles', s.id))).sort()).toEqual([
      'cues.json',
      'original.srt',
    ]);
    expect((await candidates(sample.tid)).find((x) => x.id === c.id)?.added).toBe(true);
    const dup = await call(t.app, 'POST', `/api/candidates/${c.id}/add`, { cookie: mei, body: {} });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('SUBTITLE_DUPLICATE');
    expect((await readdir(join(t.deps.config.dataDir, 'subtitles'))).filter((d) => d !== 'candidates').length).toBe(1);
  });

  it('converts Simplified to Taiwan Traditional when asked, keeping the list before conversion', async () => {
    // A film of its own: converted, this subtitle is the Traditional one added above, a duplicate there.
    const f = await film('Simplified', 'tt0000103', 2006);
    const c = await uploaded(f.tid, 'late.zh-CN.gb18030.srt');
    expect(c.language).toBe('zh-Hans');
    const res = await call(t.app, 'POST', `/api/candidates/${c.id}/add`, {
      cookie: mei,
      body: { convertToTraditional: true },
    });
    const s = res.json();
    expect(s).toMatchObject({ language: 'zh-Hant', convertedToTraditional: true });
    const files = (await readdir(join(t.deps.config.dataDir, 'subtitles', s.id))).sort();
    expect(files).toEqual(['cues.json', 'cues.original.json', 'original.srt']);
    const expected = (await readFile(fixture('late.zh-CN.to-zh-TW.expected.srt'), 'utf8'))
      .split('\n\n')[0]
      ?.split('\n')[2];
    expect((await call(t.app, 'GET', `/api/subtitles/${s.id}`, { cookie: mei })).json().cues[0].text).toBe(expected);
    // The original bytes are kept as they came (GB18030).
    expect(
      (await readFile(join(t.deps.config.dataDir, 'subtitles', s.id, 'original.srt'))).equals(
        await readFile(fixture('late.zh-CN.gb18030.srt')),
      ),
    ).toBe(true);
    // Not converted is a different subtitle (different content), so it can be added too.
    const plain = await call(t.app, 'POST', `/api/candidates/${c.id}/add`, {
      cookie: mei,
      body: { convertToTraditional: false },
    });
    expect(plain.json()).toMatchObject({ language: 'zh-Hans', convertedToTraditional: false });
    spare = { id: plain.json().id, torrentId: f.tid };
  });

  it('fetches a source’s candidate first (射手網: per-file download) and adds it', async () => {
    await db.pool.query('delete from provider_slots');
    const c = (await candidates(sample.tid)).find((x) => x.provider === 'assrt' && x.fetch === 'new') as CandidateJson;
    expect(c).toBeTruthy();
    const kick = setInterval(() => void media.reconcile(), 200);
    const res = await call(t.app, 'POST', `/api/candidates/${c.id}/add`, { cookie: mei, body: {} });
    clearInterval(kick);
    // The fake serves the same fixture as the upload above for each file, so it may already be added.
    expect([200, 409]).toContain(res.statusCode);
    const after = (await candidates(sample.tid)).filter((x) => x.provider === 'assrt');
    expect(after.find((x) => x.id === c.id)?.fetch).toBe('ready');
    // Two files in the package: the second became a candidate of its own.
    expect(after.filter((x) => x.fetch === 'ready').length).toBe(2);
    const refs = (
      await db.pool.query(`select provider_ref, download_url from subtitle_candidates where provider = 'assrt'`)
    ).rows;
    expect(refs.map((r) => r.provider_ref).sort()).toEqual(['600001', '600001#Sample.Movie.2010.cht.srt', '600002']);
    expect(refs.every((r) => r.download_url === null)).toBe(true);
  });

  describe('saving the document (docs/09, "儲存")', () => {
    it('saves with the revision, refuses a stale one with who saved, and keeps a revision on reason', async () => {
      const doc = (await call(t.app, 'GET', `/api/subtitles/${added.id}`, { cookie: mei })).json().doc;
      const moved = { ...doc, segments: [{ from: 0, scale: 1, offset: -2.3604 }] };
      const ok = await call(t.app, 'PUT', `/api/subtitles/${added.id}/doc`, {
        cookie: mei,
        body: { rev: 0, doc: moved, reason: 'auto-align' },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ rev: 1, status: 'draft' });
      expect(ok.json().score).toBeGreaterThan(0.75);
      const stale = await call(t.app, 'PUT', `/api/subtitles/${added.id}/doc`, { cookie: mei, body: { rev: 0, doc } });
      expect(stale.statusCode).toBe(409);
      expect(stale.json().error).toMatchObject({
        code: 'REVISION_CONFLICT',
        details: {
          rev: 1,
          updatedBy: { displayName: 'mei' },
          doc: { segments: [{ from: 0, scale: 1, offset: -2.36 }] },
        },
      });
      const revs = (
        await db.pool.query('select rev, reason from subtitle_revisions where subtitle_id = $1', [added.id])
      ).rows;
      expect(revs).toEqual([{ rev: 1, reason: 'auto-align' }]);
      const bad = await call(t.app, 'PUT', `/api/subtitles/${added.id}/doc`, {
        cookie: mei,
        body: { rev: 1, doc: { ...doc, segments: [{ from: 3, scale: 1, offset: 0 }] } },
      });
      expect(bad.statusCode).toBe(422);
    });

    it('confirms only with every checkpoint passed or `force`; checkpoints alone keep it confirmed, timing sends it back', async () => {
      const cur = (await call(t.app, 'GET', `/api/subtitles/${added.id}`, { cookie: mei })).json();
      const pending = await call(t.app, 'POST', `/api/subtitles/${added.id}/confirm`, {
        cookie: mei,
        body: { rev: cur.subtitle.rev },
      });
      expect(pending.statusCode).toBe(422);
      expect(pending.json().error.details).toEqual({ fields: { force: 'CHECKPOINTS_PENDING' } });
      const stale = await call(t.app, 'POST', `/api/subtitles/${added.id}/confirm`, {
        cookie: mei,
        body: { rev: 0, force: true },
      });
      expect(stale.json().error.code).toBe('REVISION_CONFLICT');
      const ok = await call(t.app, 'POST', `/api/subtitles/${added.id}/confirm`, {
        cookie: mei,
        body: { rev: cur.subtitle.rev, force: true },
      });
      expect(ok.json()).toMatchObject({ status: 'confirmed', confirmedBy: { displayName: 'mei' } });
      const marked = { ...cur.doc, checkpoints: cur.doc.checkpoints.map((c: object) => ({ ...c, status: 'ok' })) };
      const keep = await call(t.app, 'PUT', `/api/subtitles/${added.id}/doc`, {
        cookie: mei,
        body: { rev: cur.subtitle.rev, doc: marked },
      });
      expect(keep.json().status).toBe('confirmed');
      const shifted = { ...marked, edits: { '3': { dStart: 0.25 } } };
      const back = await call(t.app, 'PUT', `/api/subtitles/${added.id}/doc`, {
        cookie: mei,
        body: { rev: keep.json().rev, doc: shifted },
      });
      expect(back.json().status).toBe('draft');
    });

    it('hands out the file as SRT, with or without the sync applied', async () => {
      const raw = await call(t.app, 'GET', `/api/subtitles/${added.id}/file`, { cookie: mei });
      expect(raw.headers['content-type']).toBe('application/x-subrip; charset=utf-8');
      expect(raw.headers['content-disposition']).toContain(`filename*=UTF-8''Sample%20Movie%20(2010).zh-TW.srt`);
      expect(raw.body.split('\n')[1]).toBe('00:00:05,350 --> 00:00:07,636');
      const synced = await call(t.app, 'GET', `/api/subtitles/${added.id}/file?synced=true`, { cookie: mei });
      expect(synced.body.split('\n')[1]).toBe('00:00:02,990 --> 00:00:05,276');
    });
  });

  it('removes a subtitle with its files', async () => {
    expect((await call(t.app, 'DELETE', `/api/subtitles/${spare.id}`, { cookie: mei })).statusCode).toBe(204);
    expect(await readdir(join(t.deps.config.dataDir, 'subtitles'))).not.toContain(spare.id);
    expect((await call(t.app, 'GET', `/api/subtitles/${spare.id}`, { cookie: mei })).statusCode).toBe(404);
    expect(
      (await call(t.app, 'GET', `/api/torrents/${spare.torrentId}/subtitles`, { cookie: mei })).json().length,
    ).toBe(1);
    const audit = (await db.pool.query(`select target from audit_log where action = 'subtitle.remove'`)).rows;
    expect(audit).toEqual([{ target: { movieTitle: 'Simplified', language: 'zh-Hans' } }]);
  });
});

describe('alignment', () => {
  it('auto-align answers with segments and leaves the stored document alone', async () => {
    const c = await uploaded(inception.tid, 'late.zh-TW.srt');
    const s = (await call(t.app, 'POST', `/api/candidates/${c.id}/add`, { cookie: mei, body: {} })).json();
    const kick = setInterval(() => void media.reconcile(), 200);
    const res = await call(t.app, 'POST', `/api/subtitles/${s.id}/auto-align`, {
      cookie: mei,
      body: { allowSplit: true },
    });
    clearInterval(kick);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.segments.length).toBe(1);
    expect(Math.abs(r.segments[0].offset - -2.36)).toBeLessThanOrEqual(0.01);
    expect(r.scoreBefore).toBeLessThan(r.score);
    if (FFSUBSYNC) expect(r.agree).toBe(true);
    expect((await call(t.app, 'GET', `/api/subtitles/${s.id}`, { cookie: mei })).json().subtitle.rev).toBe(0);
    const task = (await db.pool.query(`select state, subject from tasks where kind = 'align'`)).rows[0];
    expect(task).toEqual({ state: 'done', subject: { movieTitle: 'Inception', language: 'zh-Hant' } });
  });

  it('aligns one subtitle to another of the same film, without any sound analysis', async () => {
    const f = await film('Two Subs', 'tt0000101', 2004);
    const enC = await uploaded(f.tid, 'truth.en.srt');
    const en = (await call(t.app, 'POST', `/api/candidates/${enC.id}/add`, { cookie: mei, body: {} })).json();
    const zhC = await uploaded(f.tid, 'late.zh-TW.srt');
    const zh = (await call(t.app, 'POST', `/api/candidates/${zhC.id}/add`, { cookie: mei, body: {} })).json();
    const kick = setInterval(() => void media.reconcile(), 200);
    const res = await call(t.app, 'POST', `/api/subtitles/${zh.id}/auto-align`, {
      cookie: mei,
      body: { allowSplit: true, referenceId: en.id },
    });
    clearInterval(kick);
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.method).toMatch(/^reference/);
    expect(r.reference).toMatchObject({ subtitleId: en.id, via: 'timing' });
    expect(r.segments).toHaveLength(1);
    expect(Math.abs(r.segments[0].offset + 2.4)).toBeLessThan(0.15);
    expect(r.extraLines).toEqual([]);
    // Not to itself, and not to a subtitle of another film.
    const self = await call(t.app, 'POST', `/api/subtitles/${zh.id}/auto-align`, {
      cookie: mei,
      body: { allowSplit: true, referenceId: zh.id },
    });
    expect(self.json().error).toMatchObject({
      code: 'VALIDATION',
      details: { fields: { referenceId: 'NOT_SAME_FILM' } },
    });
  });

  it('says MEDIA_NOT_READY without speech data', async () => {
    const f = await film('No Speech', 'tt0000100', 2003);
    const c = await uploaded(f.tid, 'truth.en.srt');
    const s = (await call(t.app, 'POST', `/api/candidates/${c.id}/add`, { cookie: mei, body: {} })).json();
    expect(s.score).toBeNull();
    const res = await call(t.app, 'POST', `/api/subtitles/${s.id}/auto-align`, {
      cookie: mei,
      body: { allowSplit: true },
    });
    expect(res.json().error.code).toBe('MEDIA_NOT_READY');
    const rank = await call(t.app, 'POST', `/api/torrents/${f.tid}/candidates/rank`, {
      cookie: mei,
      body: { languages: ['en'] },
    });
    expect(rank.json().error.code).toBe('MEDIA_NOT_READY');
  });

  it('ranking fetches and aligns each chosen candidate, then marks the best one per language', async () => {
    await uploaded(inception.tid, 'rate.zh-TW.srt');
    await uploaded(inception.tid, 'cut.zh-TW.srt');
    const res = await call(t.app, 'POST', `/api/torrents/${inception.tid}/candidates/rank`, {
      cookie: mei,
      body: { languages: ['zh-Hant'] },
    });
    expect(res.json().ranking).toBe('running');
    // A second press while it runs does not start another.
    await call(t.app, 'POST', `/api/torrents/${inception.tid}/candidates/rank`, {
      cookie: mei,
      body: { languages: ['zh-Hant'] },
    });
    expect((await db.pool.query(`select count(*)::int as n from tasks where kind = 'rank'`)).rows[0].n).toBe(1);
    // Uploads are ready; source candidates need their archives (bsdtar) and come out failed without it.
    await until(
      async () =>
        (await call(t.app, 'GET', `/api/torrents/${inception.tid}/candidates`, { cookie: mei })).json().ranking ===
        'done',
      120_000,
    );
    const list = await candidates(inception.tid);
    const uploads = list.filter((c) => c.provider === 'upload');
    expect(uploads.every((c) => c.align.state === 'done' && (c.align.score ?? 0) > 0.7)).toBe(true);
    expect(list.filter((c) => c.recommended).length).toBe(1);
    const task = (await db.pool.query(`select state, progress from tasks where kind = 'rank'`)).rows[0];
    expect(task).toEqual({ state: 'done', progress: 1 });
  }, 150_000);
});

describe.skipIf(!BSDTAR)('archives (in the image)', () => {
  it('an uploaded zip becomes one candidate per subtitle inside', async () => {
    const f = await film('Zip Film', 'tt0000101', 2004);
    const res = await upload(t.app, f.tid, 'subs.zip', await readFile(fixture('archive.zip')));
    expect(res.statusCode).toBe(200);
    await until(async () => (await candidates(f.tid)).every((c) => c.fetch !== 'fetching'));
    const list = await candidates(f.tid);
    expect(list.map((c) => [c.releaseName, c.language, c.fetch]).sort()).toEqual([
      ['Sample.Movie.2020.1080p.BluRay.x264.YIFY.cht.srt', 'zh-Hant', 'ready'],
      ['Sample.Movie.2020.1080p.BluRay.x264.YIFY.eng.srt', 'en', 'ready'],
    ]);
    expect(list.every((c) => c.flags.archive)).toBe(true);
  });

  it.each([
    ['broken.zip', 'ARCHIVE_INVALID'],
    ['nosubtitle.zip', 'NO_SUBTITLE'],
    ['hostile.traversal.zip', 'ARCHIVE_INVALID'],
    ['hostile.symlink.zip', 'ARCHIVE_INVALID'],
    ['hostile.bomb.zip', 'ARCHIVE_INVALID'],
  ])('%s fails with %s and leaves nothing anywhere', async (file, code) => {
    const f = await film(`Bad ${file}`, 'tt0000102', 2005);
    await upload(t.app, f.tid, file, await readFile(fixture(`archives/${file}`)));
    await until(async () => (await candidates(f.tid)).every((c) => c.fetch !== 'fetching'));
    const [c] = await candidates(f.tid);
    expect(c).toMatchObject({ fetch: 'failed', fetchError: code });
    expect(await readdir(join(t.deps.config.dataDir, 'tmp', 'uploads'))).toEqual([]);
    expect(await readdir(join(t.deps.config.dataDir, 'tmp', 'work')).catch(() => [])).toEqual([]);
    const all = spawnSync('find', [
      t.deps.config.dataDir,
      '-name',
      '*escaped*',
      '-o',
      '-name',
      'link.srt',
      '-o',
      '-name',
      'big.srt',
    ]);
    expect(String(all.stdout)).toBe('');
  });

  it('a JustSubtitles candidate is downloaded from dl.subdl.com without a query string and processed', async () => {
    const c = (await candidates(inception.tid)).find(
      (x) => x.provider === 'justsubtitles' && x.fetch !== 'ready',
    ) as CandidateJson;
    await db.pool.query(`update subtitle_candidates set fetch_state = 'new', fetch_error = null where id = $1`, [c.id]);
    const kick = setInterval(() => void media.reconcile(), 200);
    const res = await call(t.app, 'POST', `/api/candidates/${c.id}/add`, { cookie: mei, body: {} });
    clearInterval(kick);
    expect([200, 409]).toContain(res.statusCode);
    const dl = fake.requests.find((r) => r.source === 'subdl-dl');
    expect(dl?.path).toMatch(/^\/subtitle\/\d+-\d+\.zip$/);
  });
});

describe('permissions (docs/12-auth.md, "誰能做什麼")', () => {
  it('every subtitle endpoint answers 403 to someone who does not hold the film, administrators included', async () => {
    const sub = (await call(t.app, 'GET', `/api/torrents/${sample.tid}/subtitles`, { cookie: mei })).json()[0];
    const cand = (await candidates(sample.tid))[0] as CandidateJson;
    const routes: [string, string, unknown][] = [
      ['GET', `/api/torrents/${sample.tid}/candidates`, undefined],
      ['POST', `/api/torrents/${sample.tid}/subtitle-search`, { languages: ['en'] }],
      ['POST', `/api/torrents/${sample.tid}/candidates/rank`, { languages: ['en'] }],
      ['POST', `/api/candidates/${cand.id}/add`, {}],
      ['DELETE', `/api/candidates/${cand.id}`, undefined],
      ['GET', `/api/torrents/${sample.tid}/subtitles`, undefined],
      ['GET', `/api/subtitles/${sub.id}`, undefined],
      ['PUT', `/api/subtitles/${sub.id}/doc`, { rev: 0, doc: {} }],
      ['POST', `/api/subtitles/${sub.id}/auto-align`, { allowSplit: true }],
      ['POST', `/api/subtitles/${sub.id}/confirm`, { rev: 0 }],
      ['GET', `/api/subtitles/${sub.id}/file`, undefined],
      ['DELETE', `/api/subtitles/${sub.id}`, undefined],
      ['GET', `/api/library/${sample.tid}`, undefined],
    ];
    for (const who of [boss, kai])
      for (const [method, url, body] of routes) {
        const res = await call(t.app, method as 'GET', url, { cookie: who, ...(body === undefined ? {} : { body }) });
        expect(`${method} ${url} → ${res.statusCode} ${res.json().error?.code}`).toBe(
          `${method} ${url} → 403 NOT_HOLDER`,
        );
      }
    const up = await upload(t.app, sample.tid, 'x.srt', Buffer.from('x'), boss);
    expect(up.statusCode).toBe(403);
  });

  it('the workspace lists the film’s subtitles for a holder', async () => {
    const w = (await call(t.app, 'GET', `/api/library/${sample.tid}`, { cookie: mei })).json();
    expect(w.subtitles.length).toBeGreaterThan(0);
    expect(w.exports).toEqual([]);
    expect(w.item.subtitles.total).toBe(w.subtitles.length);
    expect(w.exportNeedBytes).toBe(Math.ceil(1000 * 1.01) + 1024 * 1024);
  });
});

describe('auto-align limit (docs/08, "語言模型")', () => {
  it('lets one person press auto-align 20 times in ten minutes, then says how long to wait', async () => {
    await createUser(db.pool, 'busy_aligner');
    const cookie = await login(t.app, 'busy_aligner');
    const press = () =>
      call(t.app, 'POST', '/api/subtitles/00000000-0000-4000-8000-00000000abcd/auto-align', {
        cookie,
        body: { allowSplit: true },
      });
    for (let i = 0; i < 20; i++) expect((await press()).statusCode).toBe(404);
    const blocked = await press();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toMatchObject({ code: 'RATE_LIMITED' });
    expect(blocked.json().error.details.retryAfterSeconds).toBeGreaterThan(500);
    // Someone else is not affected.
    expect(
      (
        await call(t.app, 'POST', '/api/subtitles/00000000-0000-4000-8000-00000000abcd/auto-align', {
          cookie: mei,
          body: { allowSplit: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});
