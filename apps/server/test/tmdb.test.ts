import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { type FakeSources, startFakeSources } from '@paiban/fakes/subtitles';
import { type FakeYts, startFakeYts } from '@paiban/fakes/yts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseFind, parseSearch } from '../src/tmdb/tmdb.js';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

/**
 * TMDB in place of IMDb for what people see (Brian, 2026-10-06): titles, overviews, posters and
 * ratings come from TMDB when a key is set, and from YTS otherwise. All against local fakes.
 */
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let yts: FakeYts;
let fake: FakeSources;
let boss: string;
let mei: string;

beforeAll(async () => {
  db = await testDb();
  fake = await startFakeSources();
  t = await testApp(db.pool, { sourceOverrides: fake.overrides, allowLocalSources: true });
  yts = await startFakeYts();
  await createUser(db.pool, 'boss', 'admin');
  await createUser(db.pool, 'mei', 'member');
  boss = await login(t.app, 'boss');
  mei = await login(t.app, 'mei');
});
afterAll(async () => {
  await yts.close();
  await fake.close();
  await t.app.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('delete from provider_cache');
  await db.pool.query('delete from secrets');
  await setSetting(db.pool, 'yts.baseUrl', yts.url);
  fake.reset();
});

const setKey = () =>
  call(t.app, 'PUT', '/api/admin/secrets/tmdbKey', { cookie: boss, body: { value: 'tmdb-test-key-not-real' } });

describe('reading a TMDB answer', () => {
  const answer = (m: Record<string, unknown>) => ({ movie_results: [{ id: 7, ...m }] });

  it('keeps a Chinese title only when it is not the original one', () => {
    expect(parseFind(answer({ title: '謎中謎', original_title: 'Charade' }), 'Charade')?.titleZh).toBe('謎中謎');
    expect(parseFind(answer({ title: 'Charade', original_title: 'Charade' }), 'Charade')?.titleZh).toBeNull();
  });

  it('gives no rating for a handful of votes, and refuses odd poster paths', () => {
    const few = parseFind(answer({ vote_average: 9.9, vote_count: 2, poster_path: '/../x' }), 'X');
    expect(few).toMatchObject({ rating: null, posterPath: null });
    const many = parseFind(answer({ vote_average: 7.46, vote_count: 900, poster_path: '/abc.jpg' }), 'X');
    expect(many).toMatchObject({ rating: 7.5, posterPath: '/abc.jpg' });
  });

  it('says nothing for a film TMDB does not know', () => {
    expect(parseFind({ movie_results: [] }, 'X')).toBeNull();
  });
});

describe('search and the film page', () => {
  it('without a key: YTS titles and the IMDb rating, never contacting TMDB', async () => {
    const items = (await call(t.app, 'GET', '/api/yts/movies?q=charade', { cookie: mei })).json().items;
    expect(items[0]).toMatchObject({
      title: 'Charade',
      titleZh: null,
      rating: 7.9,
      ratingSource: 'imdb',
      tmdbId: null,
    });
    const detail = (await call(t.app, 'GET', '/api/yts/movies/2', { cookie: mei })).json();
    expect(detail.tmdbUrl).toBeNull();
    expect(detail.summary).toMatch(/[a-z]/);
    expect(fake.requests.filter((r) => r.source === 'tmdb')).toEqual([]);
  });

  it('with a key: the Chinese title, TMDB rating, Chinese overview and a TMDB link', async () => {
    expect((await setKey()).statusCode).toBe(204);
    const items = (await call(t.app, 'GET', '/api/yts/movies?q=charade', { cookie: mei })).json().items;
    expect(items[0]).toMatchObject({ titleZh: '謎中謎', rating: 7.5, ratingSource: 'tmdb', tmdbId: 900_002 });
    const detail = (await call(t.app, 'GET', '/api/yts/movies/2', { cookie: mei })).json();
    expect(detail.summary).toContain('鉅款');
    expect(detail.tmdbUrl).toBe('https://www.themoviedb.org/movie/900002');
    // The answer is kept: the second look did not ask again, and the key never left in the clear twice.
    expect(fake.requests.filter((r) => r.source === 'tmdb' && r.path.startsWith('/3/find/tt9000002'))).toHaveLength(1);
  });

  it('serves the TMDB poster through this server', async () => {
    await setKey();
    const res = await call(t.app, 'GET', '/api/yts/movies/2/poster', { cookie: mei });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.subarray(1, 4).toString()).toBe('PNG');
    expect(fake.requests.some((r) => r.source === 'tmdb-img' && r.path === '/t/p/w342/fake-charade.png')).toBe(true);
  });

  it('serves the poster of the country asked for, and keeps it for a film someone has', async () => {
    await setKey();
    const tw = await call(t.app, 'GET', '/api/yts/movies/2/poster?region=TW', { cookie: mei });
    const jp = await call(t.app, 'GET', '/api/yts/movies/2/poster?region=JP', { cookie: mei });
    expect(tw.statusCode).toBe(200);
    expect(jp.statusCode).toBe(200);
    expect(Buffer.compare(tw.rawPayload, jp.rawPayload)).not.toBe(0);
    expect(fake.requests.some((r) => r.source === 'tmdb-img' && r.path.endsWith('fake-charade-ja.png'))).toBe(true);
    expect((await call(t.app, 'GET', '/api/yts/movies/2/poster?region=XX', { cookie: mei })).statusCode).toBe(422);
    // Not in anyone's library: nothing kept.
    const kept = join(t.deps.config.dataDir, 'posters', '2-JP.png');
    expect(await exists(kept)).toBe(false);
    // Once the film is in the site's library, the copy is kept and served from disk.
    await db.pool.query(`insert into movies (yts_id, imdb_code, title, year) values (2, 'tt9000002', 'Charade', 1963)`);
    await call(t.app, 'GET', '/api/yts/movies/2/poster?region=JP', { cookie: mei });
    expect(await exists(kept)).toBe(true);
    const asked = fake.requests.length;
    const again = await call(t.app, 'GET', '/api/yts/movies/2/poster?region=JP', { cookie: mei });
    expect(Buffer.compare(again.rawPayload, jp.rawPayload)).toBe(0);
    expect(fake.requests.length).toBe(asked);
    await db.pool.query('delete from movies where yts_id = 2');
  });

  it('falls back to YTS when TMDB refuses the key, and says so on the sources page', async () => {
    await call(t.app, 'PUT', '/api/admin/secrets/tmdbKey', { cookie: boss, body: { value: 'rejected-test-key' } });
    const items = (await call(t.app, 'GET', '/api/yts/movies?q=charade', { cookie: mei })).json().items;
    expect(items[0]).toMatchObject({ ratingSource: 'imdb', titleZh: null });
    const sources = (await call(t.app, 'GET', '/api/admin/settings', { cookie: boss })).json().sources;
    expect(sources.find((s: { id: string }) => s.id === 'tmdb')).toMatchObject({ state: 'warn', code: 'INVALID_KEY' });
  });

  it('gives a film the TMDB answer when a download creates its row after the page looked it up', async () => {
    await setKey();
    await setLimit(db.pool, 100 * GB);
    const detail = (await call(t.app, 'GET', '/api/yts/movies/3', { cookie: mei })).json();
    const hash = detail.versions[0].infoHash;
    const res = await call(t.app, 'POST', '/api/torrents', { cookie: mei, body: { ytsId: 3, infoHash: hash } });
    expect(res.statusCode).toBe(201);
    expect(res.json().torrent.movie.titleZh).toBe('小報妙冤家');
    const row = (await db.pool.query('select tmdb_id from movies where yts_id = 3')).rows[0];
    expect(row.tmdb_id).toBe(900_003);
  });

  it('writes the TMDB id onto a film already in the library, for the subtitle sources', async () => {
    await setKey();
    await db.pool.query(
      `insert into movies (yts_id, imdb_code, title, year, runtime_min) values (2, 'tt9000002', 'Charade', 1963, 113)`,
    );
    await call(t.app, 'GET', '/api/yts/movies/2', { cookie: mei });
    const row = (await db.pool.query(`select tmdb_id, title_zh from movies where yts_id = 2`)).rows[0];
    expect(row).toEqual({ tmdb_id: 900_002, title_zh: '謎中謎' });
  });
});

describe('suggestions as you type (Brian, 2026-10-06: Chinese titles find nothing on YTS)', () => {
  const suggest = (q: string) => call(t.app, 'GET', `/api/tmdb/suggest?q=${encodeURIComponent(q)}`, { cookie: mei });

  it('reads TMDB search answers: no adult films, a year from the date, safe poster files only', () => {
    const hits = parseSearch({
      results: [
        { id: 1, title: '謎中謎', original_title: 'Charade', release_date: '1963-12-05', poster_path: '/a-B_1.jpg' },
        { id: 2, title: 'X', original_title: 'X', release_date: '', poster_path: '/../etc', adult: false },
        { id: 3, title: 'Adult', original_title: 'Adult', adult: true },
      ],
    });
    expect(hits).toEqual([
      { tmdbId: 1, title: '謎中謎', originalTitle: 'Charade', year: 1963, posterPath: '/a-B_1.jpg' },
      { tmdbId: 2, title: 'X', originalTitle: 'X', year: null, posterPath: null },
    ]);
  });

  it('without a key: says suggestions are not available, never asking TMDB', async () => {
    const res = await suggest('謎中謎');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ items: [], available: false });
    expect(fake.requests.filter((r) => r.source === 'tmdb')).toEqual([]);
  });

  it('finds a film by its Chinese title, with year and a poster through this server, cached', async () => {
    await setKey();
    const res = (await suggest('謎中謎')).json();
    expect(res.available).toBe(true);
    expect(res.items[0]).toEqual({
      tmdbId: 900_002,
      title: '謎中謎',
      originalTitle: 'Charade',
      year: 1963,
      posterUrl: '/api/tmdb/poster/fake-charade.png',
    });
    await suggest('  謎中謎 ');
    expect(fake.requests.filter((r) => r.source === 'tmdb' && r.path.startsWith('/3/search/movie'))).toHaveLength(1);
    const img = await call(t.app, 'GET', '/api/tmdb/poster/fake-charade.png', { cookie: mei });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(fake.requests.some((r) => r.source === 'tmdb-img' && r.path === '/t/p/w92/fake-charade.png')).toBe(true);
  });

  it('turns a picked film into the YTS film with the same IMDb code', async () => {
    await setKey();
    expect((await call(t.app, 'GET', '/api/tmdb/900002/yts', { cookie: mei })).json()).toEqual({
      ytsId: 2,
      imdbCode: 'tt9000002',
    });
  });

  it('says plainly when YTS does not have the film, or TMDB does not know it', async () => {
    await setKey();
    expect((await suggest('大國民')).json().items[0]).toMatchObject({ tmdbId: 15, originalTitle: 'Citizen Kane' });
    expect((await call(t.app, 'GET', '/api/tmdb/15/yts', { cookie: mei })).json()).toEqual({
      ytsId: null,
      imdbCode: 'tt0033467',
    });
    expect((await call(t.app, 'GET', '/api/tmdb/424242/yts', { cookie: mei })).json()).toEqual({
      ytsId: null,
      imdbCode: null,
    });
  });

  it('refuses empty or odd input, odd poster names, and people who are not signed in', async () => {
    await setKey();
    expect((await suggest('   ')).statusCode).toBe(422);
    expect((await suggest('x'.repeat(101))).statusCode).toBe(422);
    expect((await call(t.app, 'GET', '/api/tmdb/poster/..%2Fsecret.png', { cookie: mei })).statusCode).toBe(422);
    expect((await call(t.app, 'GET', '/api/tmdb/poster/x.svg', { cookie: mei })).statusCode).toBe(422);
    expect((await call(t.app, 'GET', '/api/tmdb/suggest?q=charade')).statusCode).toBe(401);
  });
});
