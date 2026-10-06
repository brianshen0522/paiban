import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let boss: string;
let bossId: string;
let mei: string;
let meiId: string;
let haoId: string;
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  bossId = await createUser(db.pool, 'boss', 'admin');
  meiId = await createUser(db.pool, 'mei');
  haoId = await createUser(db.pool, 'hao');
  boss = await login(t.app, 'boss');
  mei = await login(t.app, 'mei');
});
afterAll(async () => {
  await t.app.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('delete from notifications');
  await db.pool.query('delete from exports');
  await db.pool.query('delete from storage_findings');
  await db.pool.query('delete from torrents');
  await db.pool.query('delete from movies');
  await db.pool.query('delete from service_heartbeats');
  await setLimit(db.pool, 100 * GB);
  t.disk.availableBytes = 900 * GB;
});

let n = 0;
async function torrent(state: string, holders: string[], over: { disk?: number; size?: number } = {}): Promise<string> {
  n++;
  const movie = (
    await db.pool.query(
      `insert into movies (yts_id, imdb_code, title, year) values ($1, 'tt1', $2, 1963) returning id`,
      [n, `Film ${n}`],
    )
  ).rows[0].id;
  const id = (
    await db.pool.query(
      `insert into torrents (info_hash, movie_id, quality, source_type, video_codec, size_bytes, state, disk_bytes, error_code)
       values ($1, $2, '1080p', 'bluray', 'x264', $3, $4, $5, $6) returning id`,
      [
        n.toString(16).padStart(40, '0'),
        movie,
        over.size ?? GB,
        state,
        over.disk ?? 0,
        state === 'failed' ? 'STALLED' : null,
      ],
    )
  ).rows[0].id;
  for (const u of holders)
    await db.pool.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [id, u]);
  return id;
}
const overview = async () => (await call(t.app, 'GET', '/api/admin/overview', { cookie: boss })).json();
const codes = (o: { problems: { code: string }[] }) => o.problems.map((p) => p.code);

describe('overview', () => {
  it('counts downloads, people and invites for the tiles', async () => {
    await torrent('downloading', [meiId]);
    await torrent('queued', [meiId]);
    await setSetting(db.pool, 'downloads.maxActive', 3);
    const o = await overview();
    expect(o.downloads).toEqual({ active: 1, maxActive: 3, queued: 1 });
    expect(o.users).toMatchObject({ active: 3, disabled: 0 });
    expect(o.tasks).toEqual({ running: 0, current: null });
    expect(o.recent.length).toBeGreaterThan(0);
    expect(o.recent.length).toBeLessThanOrEqual(6);
  });

  it('lists what needs attention, problems first', async () => {
    await torrent('failed', [meiId], { disk: 300 });
    await torrent('completed', []);
    await setLimit(db.pool, 1);
    t.disk.availableBytes = 3 * GB; // under twice the 2 GB reserve
    const o = await overview();
    expect(codes(o)).toEqual(
      expect.arrayContaining([
        'OVER_LIMIT',
        'DISK_LOW',
        'FAILED_DOWNLOAD',
        'YTS_NOT_CONFIGURED',
        'SERVICE_DOWN',
        'NO_HOLDERS',
      ]),
    );
    expect(o.problems.find((p: { code: string }) => p.code === 'FAILED_DOWNLOAD').data).toMatchObject({
      requestedBy: '',
      errorCode: 'STALLED',
      bytes: 300,
      version: '1080p BluRay x264',
    });
    expect(
      o.problems
        .filter((p: { code: string }) => p.code === 'SERVICE_DOWN')
        .map((p: { data: { service: string } }) => p.data.service),
    ).toEqual(['torrent', 'media']);
    const levels = o.problems.map((p: { level: string }) => p.level);
    expect(levels.indexOf('warn')).toBeGreaterThan(levels.lastIndexOf('bad'));
  });

  it('is quiet when all is well', async () => {
    await setSetting(db.pool, 'yts.baseUrl', 'https://yts.example');
    for (const s of ['api', 'torrent', 'media'])
      await db.pool.query(
        `insert into service_heartbeats (service, started_at, last_seen_at) values ($1, now(), now())`,
        [s],
      );
    expect((await overview()).problems).toEqual([]);
    await setSetting(db.pool, 'yts.baseUrl', '');
  });
});

describe('force deletion (D23)', () => {
  it('removes a film whoever holds it, tells each holder, and frees its space', async () => {
    const id = await torrent('completed', [meiId, haoId], { disk: 2 * GB });
    const res = await call(t.app, 'DELETE', `/api/admin/storage/items/movie/${id}`, { cookie: boss });
    expect(res.json()).toEqual({ freedBytes: 2 * GB });
    expect((await db.pool.query('select want from torrents where id = $1', [id])).rows[0].want).toBe('remove');
    const notes = (
      await db.pool.query(`select user_id, data from notifications where kind = 'item.deleted' order by user_id`)
    ).rows;
    expect(notes.map((x) => x.user_id).sort()).toEqual([meiId, haoId].sort());
    expect(notes[0].data).toMatchObject({
      actor: 'boss',
      itemKind: 'movie',
      movieTitle: expect.any(String),
      version: '1080p BluRay x264',
    });
    expect((await call(t.app, 'GET', '/api/notifications', { cookie: mei })).json().items[0]).toMatchObject({
      kind: 'item.deleted',
      link: null,
    });
    const log = (await db.pool.query(`select target from audit_log where action = 'admin.storage.delete'`)).rows.at(-1);
    expect(log.target).toMatchObject({ itemKind: 'movie' });
  });

  it('removes the film with all its exports: finished ones at once, a running one asked to stop', async () => {
    // Brian, 2026-10-06: deleting the whole film deletes its exports too.
    const id = await torrent('completed', [meiId], { disk: 2 * GB });
    const ins = async (state: string, file: string, bytes: number) =>
      (
        await db.pool.query(
          `insert into exports (torrent_id, movie_title, version_label, file_name, tracks, state, size_bytes, reserved_bytes, created_by)
           values ($1, 'F', 'v', $2, '[]', $3, $4, $5, $6) returning id`,
          [id, file, state, state === 'done' ? bytes : 0, state === 'done' ? 0 : bytes, meiId],
        )
      ).rows[0].id as string;
    const done = await ins('done', 'f.mkv', 500);
    const running = await ins('running', 'g.mkv', 700);
    const dir = join(t.deps.config.dataDir, 'exports', done);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'f.mkv'), 'x');
    const res = await call(t.app, 'DELETE', `/api/admin/storage/items/movie/${id}`, { cookie: boss });
    expect(res.json()).toEqual({ freedBytes: 2 * GB + 500 + 700 });
    expect(await exists(dir)).toBe(false);
    expect((await db.pool.query('select id, cancel_requested from exports')).rows).toEqual([
      { id: running, cancel_requested: true },
    ]);
    const told = (await db.pool.query(`select data from notifications where user_id = $1`, [meiId])).rows.map(
      (r) => r.data.itemKind,
    );
    expect(told.sort()).toEqual(['export', 'export', 'movie']);
  });

  it('does not notify the administrator who pressed it', async () => {
    const id = await torrent('completed', [bossId]);
    await call(t.app, 'DELETE', `/api/admin/storage/items/movie/${id}`, { cookie: boss });
    expect((await db.pool.query('select count(*)::int as n from notifications')).rows[0].n).toBe(0);
  });

  it('cancels a download in progress and removes failed leftovers', async () => {
    const running = await torrent('downloading', [meiId], { size: 3 * GB });
    expect(
      (await call(t.app, 'DELETE', `/api/admin/storage/items/reserved/${running}`, { cookie: boss })).json().freedBytes,
    ).toBe(3 * GB);
    const failed = await torrent('failed', [meiId], { disk: 300 });
    expect(
      (await call(t.app, 'DELETE', `/api/admin/storage/items/partial/${failed}`, { cookie: boss })).json().freedBytes,
    ).toBe(300);
  });

  it('refuses when the item changed since the page was loaded', async () => {
    const id = await torrent('completed', [meiId]);
    const res = await call(t.app, 'DELETE', `/api/admin/storage/items/reserved/${id}`, { cookie: boss });
    expect(res.json().error.code).toBe('TORRENT_STATE');
    expect((await db.pool.query('select want from torrents where id = $1', [id])).rows[0].want).toBe('run');
  });

  it('deletes only the preview files and keeps the film and its analysis', async () => {
    const id = await torrent('completed', [meiId]);
    const media = (
      await db.pool.query(
        `insert into media_files (torrent_id, rel_path, size_bytes, audio_state, audio_bytes, proxy_state, proxy_bytes, proxy_res, analysis_state)
         values ($1, 'a.mkv', 100, 'ready', 10, 'ready', 20, '480p', 'ready') returning id`,
        [id],
      )
    ).rows[0].id;
    const dir = join(t.deps.config.dataDir, 'media', media);
    await mkdir(dir, { recursive: true });
    for (const f of ['audio.m4a', 'proxy.mp4', 'peaks.bin']) await writeFile(join(dir, f), 'x');
    expect((await call(t.app, 'DELETE', `/api/admin/storage/items/preview/${media}`, { cookie: boss })).json()).toEqual(
      { freedBytes: 30 },
    );
    expect(await exists(join(dir, 'audio.m4a'))).toBe(false);
    expect(await exists(join(dir, 'proxy.mp4'))).toBe(false);
    expect(await exists(join(dir, 'peaks.bin'))).toBe(true);
    expect(
      (await db.pool.query('select audio_state, proxy_state, proxy_bytes, analysis_state from media_files')).rows[0],
    ).toEqual({
      audio_state: 'none',
      proxy_state: 'none',
      proxy_bytes: 0,
      analysis_state: 'ready',
    });
    expect((await db.pool.query('select want from torrents where id = $1', [id])).rows[0].want).toBe('run');
    expect(
      (await call(t.app, 'DELETE', `/api/admin/storage/items/preview/${media}`, { cookie: boss })).statusCode,
    ).toBe(404);
  });

  it('deletes a finished export, and asks a running one to stop', async () => {
    const done = (
      await db.pool.query(
        `insert into exports (movie_title, version_label, file_name, tracks, state, size_bytes, created_by) values ('F', 'v', 'f.mkv', '[]', 'done', 500, $1) returning id`,
        [meiId],
      )
    ).rows[0].id;
    const dir = join(t.deps.config.dataDir, 'exports', done);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'f.mkv'), 'x');
    expect((await call(t.app, 'DELETE', `/api/admin/storage/items/export/${done}`, { cookie: boss })).json()).toEqual({
      freedBytes: 500,
    });
    expect(await exists(dir)).toBe(false);
    expect(
      (await db.pool.query(`select data from notifications where user_id = $1`, [meiId])).rows[0].data,
    ).toMatchObject({ itemKind: 'export', fileName: 'f.mkv' });
    const running = (
      await db.pool.query(
        `insert into exports (movie_title, version_label, file_name, tracks, state, reserved_bytes) values ('F', 'v', 'g.mkv', '[]', 'running', 700) returning id`,
      )
    ).rows[0].id;
    expect(
      (await call(t.app, 'DELETE', `/api/admin/storage/items/export/${running}`, { cookie: boss })).json(),
    ).toEqual({ freedBytes: 700 });
    expect(
      (await db.pool.query('select cancel_requested from exports where id = $1', [running])).rows[0].cancel_requested,
    ).toBe(true);
  });

  it('deletes an orphan folder only while it still belongs to nothing', async () => {
    const name = 'f'.repeat(40);
    const dir = join(t.deps.config.dataDir, 'torrents', name);
    await mkdir(dir, { recursive: true });
    const f = (
      await db.pool.query(
        `insert into storage_findings (kind, root, name, bytes) values ('orphan', 'torrents', $1, 1234) returning id`,
        [name],
      )
    ).rows[0].id;
    // Meanwhile a download with that very hash appeared: refuse.
    const movie = (
      await db.pool.query(
        `insert into movies (yts_id, imdb_code, title, year) values (999, 'tt9', 'X', 2000) returning id`,
      )
    ).rows[0].id;
    await db.pool.query(`insert into torrents (info_hash, movie_id, quality, size_bytes) values ($1, $2, '720p', 1)`, [
      name,
      movie,
    ]);
    expect(
      (await call(t.app, 'DELETE', `/api/admin/storage/items/orphan/${f}`, { cookie: boss })).json().error.code,
    ).toBe('TORRENT_STATE');
    expect(await exists(dir)).toBe(true);
    await db.pool.query('delete from torrents where info_hash = $1', [name]);
    expect((await call(t.app, 'DELETE', `/api/admin/storage/items/orphan/${f}`, { cookie: boss })).json()).toEqual({
      freedBytes: 1234,
    });
    expect(await exists(dir)).toBe(false);
  });

  it('lists every item for the administrator, holder-less ones and exports included', async () => {
    await torrent('completed', []);
    await db.pool.query(
      `insert into exports (movie_title, version_label, file_name, tracks, state, size_bytes, created_by) values ('F', 'v', 'h.mkv', '[]', 'done', 5, $1)`,
      [meiId],
    );
    const items = (await call(t.app, 'GET', '/api/admin/storage', { cookie: boss })).json().items;
    expect(items.map((i: { kind: string }) => i.kind).sort()).toEqual(['export', 'movie']);
    expect(items.find((i: { kind: string }) => i.kind === 'movie').holders).toEqual([]);
  });
});
