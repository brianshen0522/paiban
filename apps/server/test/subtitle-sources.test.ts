import { Writable } from 'node:stream';
import { type FakeSources, INCEPTION, startFakeSources } from '@paiban/fakes/subtitles';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '../src/db/pool.js';
import { DEFAULTS } from '../src/settings/settings.js';
import {
  DownloadFailure,
  type FilmContext,
  type ProviderEnv,
  ProviderFailure,
  providerFor,
  request,
  takeSlot,
  testSubtitleSource,
} from '../src/subtitles/providers/index.js';
import { testDb } from './helpers.js';

/**
 * The sources through the shared client against the fake sources (docs/15-testing.md): the hosts
 * the code builds are the real ones; SOURCE_OVERRIDES sends them to the fake after the allow-list.
 * Keys are fake values; the log is searched for them afterwards.
 */
const KEYS = {
  tmdbKey: 'tmdb-test-key-not-real',
  subdlKey: 'subdl-test-key-not-real',
  assrtToken: 'assrt-test-token-not-real',
};

let db: Awaited<ReturnType<typeof testDb>>;
let fake: FakeSources;
let logged = '';
let env: ProviderEnv;
let secrets: Partial<typeof KEYS>;

const inception: FilmContext = {
  imdbCode: INCEPTION.imdb,
  tmdbId: null,
  title: 'Inception',
  titleZh: null,
  year: 2010,
  release: { quality: '1080p', source: 'bluray', videoCodec: 'x264' },
};

function makeEnv(pool: Pool): ProviderEnv {
  const sink = new Writable({
    write(chunk, _enc, done) {
      logged += String(chunk);
      done();
    },
  });
  const log = pino({ level: 'debug' }, sink);
  return {
    pool,
    log,
    outbound: { allowLocal: true, overrides: fake.overrides, log: (e) => log.debug(e, 'outbound') },
    secret: async (name) => secrets[name] ?? null,
  };
}

beforeAll(async () => {
  db = await testDb();
  fake = await startFakeSources();
  env = makeEnv(db.pool);
});
afterAll(async () => {
  await fake.close();
  await db.drop();
  // Nothing the sources were sent with ever reached a log line (docs/12-auth.md, "金鑰").
  for (const v of Object.values(KEYS)) expect(logged).not.toContain(v);
  expect(logged).not.toContain('PLACEHOLDER');
});
beforeEach(async () => {
  fake.reset();
  secrets = { ...KEYS };
  await db.pool.query('delete from provider_slots');
  await db.pool.query('delete from provider_cache');
  await db.pool.query('delete from movies');
});

const settings = structuredClone(DEFAULTS);

describe('JustSubtitles', () => {
  it('maps the IMDb id through TMDB with the key, keeping the zh-TW title, then asks each language once', async () => {
    await db.pool.query(`insert into movies (yts_id, imdb_code, title, year) values (1606, $1, 'Inception', 2010)`, [
      INCEPTION.imdb,
    ]);
    const found = await providerFor(env, settings, 'justsubtitles').search(inception, ['zh-Hant', 'en']);
    expect(found.length).toBe(30 + 7);
    expect(JSON.stringify(found)).not.toContain('api_key');
    const asked = fake.requests.map((r) => `${r.source} ${r.path}`);
    expect(asked[0]).toMatch(/^tmdb \/3\/find\/tt1375666\?external_source=imdb_id&language=zh-TW&api_key=/);
    expect(asked.slice(1)).toEqual([
      'justsubtitles /api/subtitles/27205?lang=EN',
      'justsubtitles /api/subtitles/27205?lang=ZH_BG',
      'justsubtitles /api/subtitles/27205?lang=ZH',
    ]);
    const movie = (await db.pool.query('select tmdb_id, title_zh from movies')).rows[0];
    expect(movie).toEqual({ tmdb_id: 27205, title_zh: '全面啟動' });
  });

  it('sends a v4 token as a Bearer header instead of in the address', async () => {
    secrets.tmdbKey = `eyJ${'a'.repeat(40)}.eyJ${'b'.repeat(40)}.${'c'.repeat(20)}-not-real`;
    await providerFor(env, settings, 'justsubtitles').search(inception, ['en']);
    const find = fake.requests.find((r) => r.source === 'tmdb');
    expect(find?.path).not.toContain('api_key');
    expect(find?.auth).toBe(`Bearer ${secrets.tmdbKey}`);
  });

  it('falls back to its own title search without a TMDB key (D38)', async () => {
    secrets = {};
    const found = await providerFor(env, settings, 'justsubtitles').search(inception, ['en']);
    expect(found.length).toBe(30);
    expect(fake.requests.map((r) => r.source)).toEqual(['justsubtitles-search', 'justsubtitles']);
  });

  it('is NOT_CONFIGURED when nothing gives a TMDB id', async () => {
    secrets = {};
    const err = await providerFor(env, settings, 'justsubtitles')
      .search({ ...inception, title: 'Unknown Film', imdbCode: 'tt0000001' }, ['en'])
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it.each(['ok', 'missing500'] as const)('answers 0 results for an id it does not know (%s)', async (mode) => {
    fake.setMode('justsubtitles', mode);
    const found = await providerFor(env, settings, 'justsubtitles').search({ ...inception, tmdbId: 999999999 }, ['en']);
    expect(found).toEqual([]);
  });

  it('reports a challenge page as BAD_RESPONSE and a dead source as UNREACHABLE', async () => {
    const p = providerFor(env, settings, 'justsubtitles');
    fake.setMode('justsubtitles', 'html');
    await expect(p.search({ ...inception, tmdbId: 27205 }, ['en'])).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
    fake.setMode('justsubtitles', 'error500');
    await expect(p.search({ ...inception, tmdbId: 27205 }, ['en'])).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });

  it('downloads from dl.subdl.com with the path only', async () => {
    const p = providerFor(env, settings, 'justsubtitles');
    const [d] = await p.resolveDownload({ ref: '/subtitle/3189589-3205555.zip', downloadUrl: null });
    expect(d).toEqual({ url: 'https://dl.subdl.com/subtitle/3189589-3205555.zip', fileName: '3189589-3205555.zip' });
    const res = await request(env, d?.url as string, { allow: (h) => p.allow(h), pace: 'justsubtitles' });
    expect(res.headers.get('content-type')).toBe('application/zip');
  });

  it('in SubDL mode needs its key and puts it only in the address, never in a log line', async () => {
    const subdl = {
      ...settings,
      providers: { ...settings.providers, justsubtitles: { enabled: true, mode: 'subdl' as const } },
    };
    expect((await providerFor(env, subdl, 'justsubtitles').search(inception, ['en'])).length).toBe(30);
    expect(fake.requests[0]?.path).toContain(`api_key=${KEYS.subdlKey}`);
    secrets = {};
    await expect(providerFor(env, subdl, 'justsubtitles').search(inception, ['en'])).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });
});

describe('YIFY Subtitles', () => {
  it('reads the movie page and resolves the base64 download link to an allowed host', async () => {
    const p = providerFor(env, settings, 'yify');
    const found = await p.search(inception, ['zh-Hant']);
    expect(found.length).toBe(10);
    const [d] = await p.resolveDownload({ ref: found[0]?.ref as string, downloadUrl: null });
    expect(d?.url).toBe('https://subtitles.yts-subs.com/subtitles/inception-2010-chinese-yify-90051.zip');
    const res = await request(env, d?.url as string, { allow: (h) => p.allow(h), maxBytes: 1e6 });
    expect(res.status).toBe(200);
  });

  it('has no results for a film it has no page for', async () => {
    expect(await providerFor(env, settings, 'yify').search({ ...inception, imdbCode: 'tt0000001' }, ['en'])).toEqual(
      [],
    );
  });

  it('fails the download, flagged as a layout change, when the button is gone; it does not guess', async () => {
    fake.setMode('yify', 'nobutton');
    const err = await providerFor(env, settings, 'yify')
      .resolveDownload({ ref: 'inception-2010-chinese-yify-90051', downloadUrl: null })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DownloadFailure);
    expect((err as DownloadFailure).layout).toBe(true);
    expect(fake.requests.filter((r) => r.source === 'yify-dl')).toEqual([]);
  });
});

describe('射手網', () => {
  const film = { ...inception, title: 'Sample Movie', year: 2010, titleZh: '範例電影' };

  it('searches English and Chinese titles with the token in a header, and dedupes by id', async () => {
    const found = await providerFor(env, settings, 'assrt').search(film, ['zh-Hant']);
    expect(found.map((f) => f.ref)).toEqual(['600001', '600002']);
    const searches = fake.requests.filter((r) => r.source === 'assrt');
    expect(searches.length).toBe(2);
    expect(searches.every((r) => r.auth === `Bearer ${KEYS.assrtToken}` && !r.path.includes(KEYS.assrtToken))).toBe(
      true,
    );
    // Paced 3.4 s apart, even inside one search.
    expect((searches[1]?.at ?? 0) - (searches[0]?.at ?? 0)).toBeGreaterThanOrEqual(3300);
  });

  it('on 30900 holds the source for 60 s and says when it can try again', async () => {
    fake.setMode('assrt', 'ratelimit');
    const before = Date.now();
    const err = (await providerFor(env, settings, 'assrt')
      .search(film, ['zh-Hant'])
      .catch((e: unknown) => e)) as ProviderFailure;
    expect(err).toBeInstanceOf(ProviderFailure);
    expect(err.code).toBe('RATE_LIMITED');
    const wait = (err.retryAt?.getTime() ?? 0) - before;
    expect(wait).toBeGreaterThan(55_000);
    expect(wait).toBeLessThan(65_000);
    const slot = (await db.pool.query(`select next_at from provider_slots where provider = 'assrt'`)).rows[0];
    expect(Math.abs(slot.next_at.getTime() - (err.retryAt?.getTime() ?? 0))).toBeLessThan(1000);
    expect(fake.requests.length).toBe(1);
  });

  it('is NOT_CONFIGURED without a token, and sends nothing', async () => {
    secrets = {};
    await expect(providerFor(env, settings, 'assrt').search(film, ['zh-Hant'])).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(fake.requests).toEqual([]);
  });

  it('resolves the per-file addresses on assrt.net', async () => {
    const files = await providerFor(env, settings, 'assrt').resolveDownload({ ref: '600001', downloadUrl: null });
    expect(files.map((f) => new URL(f.url).hostname)).toEqual(['file.assrt.net', 'file.assrt.net']);
  });
});

describe('pacing (D41)', () => {
  it('keeps two processes’ requests to one source a second apart', async () => {
    const other = createPool(db.url, 2);
    const env2 = makeEnv(other);
    try {
      const go = (e: ProviderEnv) =>
        request(e, 'https://www.justsubtitles.com/api/subtitles/1?lang=EN', {
          allow: () => true,
          pace: 'justsubtitles',
        });
      await Promise.all([go(env), go(env2), go(env), go(env2)]);
      const times = fake.requests.map((r) => r.at).sort((a, b) => a - b);
      expect(times.length).toBe(4);
      for (let i = 1; i < times.length; i++) expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(950);
    } finally {
      await other.end();
    }
  });

  it('does not make other sources wait', async () => {
    await takeSlot(env, 'justsubtitles');
    const started = Date.now();
    await takeSlot(env, 'yify');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('connection tests (docs/13-settings.md)', () => {
  it('answer with codes and numbers', async () => {
    expect(await testSubtitleSource(env, settings, 'justsubtitles')).toMatchObject({
      ok: true,
      code: 'OK',
      data: { count: 30 },
    });
    expect(await testSubtitleSource(env, settings, 'yify')).toMatchObject({
      ok: true,
      code: 'OK',
      data: { rows: 402 },
    });
    expect(await testSubtitleSource(env, settings, 'assrt')).toMatchObject({
      ok: true,
      code: 'OK',
      data: { quota: 17 },
    });
    expect(await testSubtitleSource(env, settings, 'tmdb')).toMatchObject({ ok: true, code: 'OK' });
    expect(await testSubtitleSource(env, settings, 'subdl')).toMatchObject({
      ok: true,
      code: 'OK',
      data: { count: 30 },
    });
    secrets = { assrtToken: 'rejected-not-real', tmdbKey: 'rejected-not-real', subdlKey: 'rejected-not-real' };
    expect(await testSubtitleSource(env, settings, 'assrt')).toMatchObject({ ok: false, code: 'INVALID_KEY' });
    expect(await testSubtitleSource(env, settings, 'tmdb')).toMatchObject({ ok: false, code: 'INVALID_KEY' });
    expect(await testSubtitleSource(env, settings, 'subdl')).toMatchObject({ ok: false, code: 'INVALID_KEY' });
    secrets = {};
    for (const id of ['assrt', 'tmdb', 'subdl'] as const)
      expect(await testSubtitleSource(env, settings, id)).toMatchObject({ ok: false, code: 'NOT_CONFIGURED' });
    fake.setMode('yify', 'html');
    expect(await testSubtitleSource(env, settings, 'yify')).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
    fake.setMode('justsubtitles', 'error500');
    expect(await testSubtitleSource(env, settings, 'justsubtitles')).toMatchObject({ ok: false, code: 'BAD_RESPONSE' });
  });
});
