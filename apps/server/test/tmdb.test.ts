import { type FakeSources, startFakeSources } from '@paiban/fakes/subtitles';
import { type FakeYts, startFakeYts } from '@paiban/fakes/yts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { parseFind } from '../src/tmdb/tmdb.js';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

/**
 * TMDB in place of IMDb for what people see (Brian, 2026-10-06): titles, overviews, posters and
 * ratings come from TMDB when a key is set, and from YTS otherwise. All against local fakes.
 */
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
