import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { film, fixture, subtitle } from './export-helpers.js';
import { call, createUser, login, type TestApp, testApp, testDb } from './helpers.js';

/**
 * The site-wide library (Brian, 2026-10-09; docs/11-pages.md, "片庫"): everyone sees every finished
 * film and joins one with a press, no space taken; holding and deleting stay as they were.
 */
let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let meiId: string;
let mei: string;
let hao: string;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  meiId = await createUser(db.pool, 'mei');
  await createUser(db.pool, 'hao');
  mei = await login(t.app, 'mei');
  hao = await login(t.app, 'hao');
});
afterAll(async () => {
  await t?.app.close();
  await db?.drop();
});

describe('the site-wide library', () => {
  it('lists every finished film for everyone, with its holders and confirmed subtitle languages', async () => {
    const dataDir = t.deps.config.dataDir;
    const done = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    await subtitle(db.pool, dataDir, done.tid, 'truth.zh-TW.srt');
    await subtitle(db.pool, dataDir, done.tid, 'late.zh-TW.srt');
    await subtitle(db.pool, dataDir, done.tid, 'truth.en.srt', { language: 'en' });
    await subtitle(db.pool, dataDir, done.tid, 'rate.zh-TW.srt', { language: 'ja', status: 'draft' });
    await film(db.pool, dataDir, fixture('clip.mp4'), [meiId], { state: 'downloading' });

    expect((await call(t.app, 'GET', '/api/library', { cookie: hao })).json()).toEqual([]);
    const all = (await call(t.app, 'GET', '/api/library?scope=all', { cookie: hao })).json();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      torrent: { id: done.tid, mine: false, holders: [{ id: meiId }] },
      subtitles: { total: 4, confirmed: 3, draft: 1 },
      confirmedLanguages: ['en', 'zh-Hant'],
    });
    const mine = (await call(t.app, 'GET', '/api/library?scope=all', { cookie: mei })).json();
    expect(mine[0].torrent.mine).toBe(true);
  });

  it('joins a film with one press, without asking YTS or taking space, and only once', async () => {
    const f = await film(db.pool, t.deps.config.dataDir, fixture('clip.mp4'), [meiId]);
    const before = (await call(t.app, 'GET', '/api/storage', { cookie: hao })).json().usage.usedBytes;
    const res = await call(t.app, 'POST', `/api/torrents/${f.tid}/hold`, { cookie: hao });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: f.tid, mine: true });
    expect(res.json().holders).toHaveLength(2);
    expect((await call(t.app, 'POST', `/api/torrents/${f.tid}/hold`, { cookie: hao })).statusCode).toBe(200);
    const holders = await db.pool.query('select user_id from torrent_holders where torrent_id = $1', [f.tid]);
    expect(holders.rowCount).toBe(2);
    expect((await call(t.app, 'GET', '/api/storage', { cookie: hao })).json().usage.usedBytes).toBe(before);
    expect((await call(t.app, 'GET', `/api/library/${f.tid}`, { cookie: hao })).statusCode).toBe(200);
    const logged = await db.pool.query(`select action, target from audit_log where action = 'torrent.join'`);
    expect(logged.rows.at(-1)).toMatchObject({ target: { movieTitle: expect.any(String) } });

    // Leaving again works as before: someone still holds it, so nothing is deleted.
    const left = await call(t.app, 'DELETE', `/api/torrents/${f.tid}/hold`, { cookie: hao });
    expect(left.json()).toMatchObject({ deleted: false });
  });

  it('refuses a film that is being deleted or does not exist', async () => {
    const f = await film(db.pool, t.deps.config.dataDir, fixture('clip.mp4'), [meiId]);
    await db.pool.query(`update torrents set want = 'remove' where id = $1`, [f.tid]);
    expect((await call(t.app, 'POST', `/api/torrents/${f.tid}/hold`, { cookie: hao })).json().error.code).toBe(
      'NOT_FOUND',
    );
    expect(
      (await call(t.app, 'POST', '/api/torrents/00000000-0000-4000-8000-000000000000/hold', { cookie: hao })).json()
        .error.code,
    ).toBe('NOT_FOUND');
    const removed = (await call(t.app, 'GET', '/api/library?scope=all', { cookie: hao })).json();
    expect(removed.some((i: { torrent: { id: string } }) => i.torrent.id === f.tid)).toBe(false);
  });

  it('needs a signed-in person', async () => {
    expect((await call(t.app, 'GET', '/api/library?scope=all')).statusCode).toBe(401);
  });
});
