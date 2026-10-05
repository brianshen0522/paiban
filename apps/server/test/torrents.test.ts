import { type FakeYts, startFakeYts } from '@paiban/fakes/yts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let yts: FakeYts;
let mei: string;
let hao: string;
let boss: string;

type V = {
  infoHash: string;
  sizeBytes: number;
  needBytes: number;
  previewBytes: number;
  quality: string;
  videoCodec: string;
};
const versions = async (ytsId: number): Promise<V[]> =>
  (await call(t.app, 'GET', `/api/yts/movies/${ytsId}`, { cookie: mei })).json().versions;
const download = (cookie: string, ytsId: number, infoHash: string, extra: object = {}) =>
  call(t.app, 'POST', '/api/torrents', { cookie, body: { ytsId, infoHash, ...extra } });

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  yts = await startFakeYts();
  await setSetting(db.pool, 'yts.baseUrl', yts.url);
  await createUser(db.pool, 'mei');
  await createUser(db.pool, 'hao');
  await createUser(db.pool, 'boss', 'admin');
  mei = await login(t.app, 'mei');
  hao = await login(t.app, 'hao');
  boss = await login(t.app, 'boss');
});
afterAll(async () => {
  await yts.close();
  await t.app.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('delete from torrents');
  await db.pool.query('delete from movies');
  await setLimit(db.pool, 100 * GB);
  t.disk.availableBytes = 900 * GB;
});

describe('accepting a download', () => {
  it('reserves the full size plus the preview reservation from the start', async () => {
    const [, , v2160] = await versions(1);
    const res = await download(mei, 1, v2160.infoHash);
    expect(res.statusCode).toBe(201);
    const { torrent, joined } = res.json();
    expect(joined).toBe(false);
    expect(torrent).toMatchObject({
      status: 'queued',
      mine: true,
      queuePosition: 1,
      sizeBytes: v2160.sizeBytes,
      holders: [{ displayName: 'mei' }],
    });
    const usage = (await call(t.app, 'GET', '/api/storage', { cookie: hao })).json().usage;
    expect(usage.categories.reserved).toBe(v2160.needBytes);
    const row = (await db.pool.query('select preview_reserve_bytes, preview_proxy_res from torrents')).rows[0];
    expect(row).toEqual({ preview_reserve_bytes: v2160.previewBytes, preview_proxy_res: '480p' });
  });

  it('freezes the preview plan at admission (D40)', async () => {
    const [, , v2160] = await versions(1);
    await download(mei, 1, v2160.infoHash);
    await setSetting(db.pool, 'media.proxyResolution', '720p');
    const row = (await db.pool.query('select preview_reserve_bytes, preview_proxy_res from torrents')).rows[0];
    expect(row.preview_proxy_res).toBe('480p');
    await setSetting(db.pool, 'media.proxyResolution', '480p');
  });

  it('only accepts a hash YTS lists for that film, and uses the server’s own numbers', async () => {
    const [v720] = await versions(1);
    const other = await download(mei, 2, v720.infoHash);
    expect([other.statusCode, other.json().error.code]).toEqual([422, 'HASH_NOT_FROM_YTS']);
    const made = await download(mei, 1, 'a'.repeat(40));
    expect(made.json().error.code).toBe('HASH_NOT_FROM_YTS');
    const sneaky = await download(mei, 1, v720.infoHash, { sizeBytes: 1, magnet: 'magnet:?xt=urn:btih:x' });
    expect(sneaky.statusCode).toBe(201);
    expect(sneaky.json().torrent.sizeBytes).toBe(v720.sizeBytes);
    expect((await db.pool.query('select count(*)::int as n from torrents')).rows[0].n).toBe(1);
  });

  it('accepts exactly the remaining space and refuses one byte more', async () => {
    const [v720] = await versions(1);
    await setLimit(db.pool, v720.needBytes);
    expect((await download(mei, 1, v720.infoHash)).statusCode).toBe(201);
    await db.pool.query('delete from torrents');
    await setLimit(db.pool, v720.needBytes - 1);
    const res = await download(mei, 1, v720.infoHash);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({
      code: 'STORAGE_LIMIT',
      details: { needBytes: v720.needBytes, shortBytes: 1, freeBytes: v720.needBytes - 1, previewBytes: 0 },
    });
    expect((await db.pool.query('select count(*)::int as n from torrents')).rows[0].n).toBe(0);
  });

  it('lets exactly one of two simultaneous downloads take the last space', async () => {
    const [, a] = await versions(3); // 1.5 GB
    const [, b] = await versions(4); // 1.5 GB
    await setLimit(db.pool, Math.max(a.needBytes, b.needBytes) + 1 * GB);
    const results = await Promise.all([download(mei, 3, a.infoHash), download(hao, 4, b.infoHash)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  it('joins a version someone already has without taking space, whatever is left', async () => {
    const [v720] = await versions(1);
    await download(mei, 1, v720.infoHash);
    await setLimit(db.pool, 1); // nothing fits any more
    const res = await download(hao, 1, v720.infoHash);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ joined: true, torrent: { mine: true } });
    expect(res.json().torrent.holders.map((h: { displayName: string }) => h.displayName)).toEqual(['mei', 'hao']);
  });

  it('turns two simultaneous downloads of the same new version into one download and a join', async () => {
    const [v720] = await versions(2);
    const [a, b] = await Promise.all([download(mei, 2, v720.infoHash), download(hao, 2, v720.infoHash)]);
    expect([a.json().joined, b.json().joined].sort()).toEqual([false, true]);
    expect((await db.pool.query('select count(*)::int as n from torrent_holders')).rows[0].n).toBe(2);
  });

  it('refuses a version that is being deleted', async () => {
    const [v720] = await versions(1);
    await download(mei, 1, v720.infoHash);
    await db.pool.query(`update torrents set want = 'remove'`);
    const res = await download(hao, 1, v720.infoHash);
    expect(res.json().error.code).toBe('TORRENT_STATE');
  });

  it('refuses everything when no limit has been set', async () => {
    await db.pool.query(`delete from settings where key = 'storage.limitBytes'`);
    const [v720] = await versions(1);
    expect((await download(mei, 1, v720.infoHash)).json().error.code).toBe('STORAGE_LIMIT');
  });

  it('says DISK_FULL when the disk itself is short although the limit is not reached', async () => {
    const [v720] = await versions(1);
    t.disk.availableBytes = 2 * GB + v720.needBytes - 1; // the 2 GB system reserve is never handed out
    const res = await download(mei, 1, v720.infoHash);
    expect([res.statusCode, res.json().error.code]).toEqual([507, 'DISK_FULL']);
  });
});

describe('holders only', () => {
  it('hides other people’s downloads, administrators included', async () => {
    const [v720] = await versions(1);
    const id = (await download(mei, 1, v720.infoHash)).json().torrent.id;
    expect((await call(t.app, 'GET', `/api/torrents/${id}`, { cookie: hao })).json().error.code).toBe('NOT_HOLDER');
    expect((await call(t.app, 'GET', `/api/torrents/${id}`, { cookie: boss })).json().error.code).toBe('NOT_HOLDER');
    expect((await call(t.app, 'POST', `/api/torrents/${id}/pause`, { cookie: boss })).statusCode).toBe(403);
    expect((await call(t.app, 'GET', '/api/torrents', { cookie: hao })).json()).toEqual([]);
    expect((await call(t.app, 'GET', '/api/torrents?scope=all', { cookie: hao })).statusCode).toBe(403);
    const all = (await call(t.app, 'GET', '/api/torrents?scope=all', { cookie: boss })).json();
    expect(all).toHaveLength(1);
    expect(all[0].mine).toBe(false);
  });
});

describe('pause, resume, retry', () => {
  it('only writes the wish; the state follows from the torrent worker', async () => {
    const [v720] = await versions(1);
    const id = (await download(mei, 1, v720.infoHash)).json().torrent.id;
    expect((await call(t.app, 'POST', `/api/torrents/${id}/pause`, { cookie: mei })).statusCode).toBe(200);
    expect((await db.pool.query('select want, state from torrents')).rows[0]).toEqual({
      want: 'pause',
      state: 'queued',
    });
    expect((await call(t.app, 'POST', `/api/torrents/${id}/resume`, { cookie: mei })).json().error.code).toBe(
      'TORRENT_STATE',
    );
    await db.pool.query(`update torrents set state = 'paused'`);
    expect((await call(t.app, 'POST', `/api/torrents/${id}/resume`, { cookie: mei })).statusCode).toBe(200);
    expect((await db.pool.query('select want from torrents')).rows[0].want).toBe('run');
    expect((await call(t.app, 'POST', `/api/torrents/${id}/retry`, { cookie: mei })).json().error.code).toBe(
      'TORRENT_STATE',
    );
  });

  it('retries a failed download counting its leftovers as already there', async () => {
    const [v720] = await versions(1);
    const id = (await download(mei, 1, v720.infoHash)).json().torrent.id;
    await db.pool.query(`update torrents set state = 'failed', error_code = 'STALLED', disk_bytes = $1`, [
      300 * 1024 ** 2,
    ]);
    // Only the leftovers count now. A limit that fits the whole version but not version + leftovers
    // must still accept the retry, because the leftovers are released by it.
    await setLimit(db.pool, v720.needBytes);
    const res = await call(t.app, 'POST', `/api/torrents/${id}/retry`, { cookie: mei });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', error: null });
  });
});

describe('leaving a download', () => {
  it('keeps the files while someone else still holds it', async () => {
    const [v720] = await versions(1);
    const id = (await download(mei, 1, v720.infoHash)).json().torrent.id;
    await download(hao, 1, v720.infoHash);
    const res = await call(t.app, 'DELETE', `/api/torrents/${id}/hold`, { cookie: mei });
    expect(res.json()).toEqual({ deleted: false, freedBytes: 0 });
    expect((await db.pool.query('select want from torrents')).rows[0].want).toBe('run');
  });

  it('marks it for removal when the last holder leaves, and from then on it is gone', async () => {
    const [v720] = await versions(1);
    const id = (await download(mei, 1, v720.infoHash)).json().torrent.id;
    const res = await call(t.app, 'DELETE', `/api/torrents/${id}/hold`, { cookie: mei });
    expect(res.json()).toEqual({ deleted: true, freedBytes: v720.needBytes });
    expect((await db.pool.query('select want from torrents')).rows[0].want).toBe('remove');
    expect((await call(t.app, 'GET', `/api/torrents/${id}`, { cookie: mei })).statusCode).toBe(404);
    expect((await call(t.app, 'GET', '/api/torrents', { cookie: mei })).json()).toEqual([]);
  });

  it('records the actions in the activity log', async () => {
    const [v720] = await versions(1);
    const id = (await download(mei, 1, v720.infoHash)).json().torrent.id;
    await call(t.app, 'DELETE', `/api/torrents/${id}/hold`, { cookie: mei });
    const actions = (
      await db.pool.query(`select action, target from audit_log where action like 'torrent.%' order by id desc limit 2`)
    ).rows;
    expect(actions.map((a) => a.action)).toEqual(['torrent.delete', 'torrent.add']);
    expect(actions[0].target).toEqual({ movieTitle: 'Night of the Living Dead', version: '720p BluRay x264' });
  });
});

describe('the capacity limit', () => {
  it('may be set below what is used; nothing new can start then', async () => {
    const [v720, v1080] = await versions(1);
    await download(mei, 1, v720.infoHash);
    const res = await call(t.app, 'PUT', '/api/admin/storage/limit', { cookie: boss, body: { limitBytes: 1 * GB } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ limitBytes: 1 * GB, over: false });
    expect((await download(hao, 1, v1080.infoHash)).json().error.code).toBe('STORAGE_LIMIT');
    expect((await db.pool.query('select count(*)::int as n from torrents')).rows[0].n).toBe(1);
  });

  it('validates the limit', async () => {
    const bad = await call(t.app, 'PUT', '/api/admin/storage/limit', { cookie: boss, body: { limitBytes: 1.5 * GB } });
    expect(bad.json().error.details.fields.limitBytes).toBe('NOT_WHOLE_GB');
    const huge = await call(t.app, 'PUT', '/api/admin/storage/limit', {
      cookie: boss,
      body: { limitBytes: 10_000 * GB },
    });
    expect(huge.json().error.details.fields.limitBytes).toBe('ABOVE_DISK');
    const member = await call(t.app, 'PUT', '/api/admin/storage/limit', { cookie: mei, body: { limitBytes: 5 * GB } });
    expect(member.statusCode).toBe(403);
  });
});
