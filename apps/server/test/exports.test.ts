import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { exportNeedBytes, SyncCore } from '@paiban/shared';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportsForTorrent } from '../src/exports/view.js';
import type { Engine } from '../src/torrent/engine.js';
import { TorrentWorker } from '../src/torrent/worker.js';
import { film, fixture, idleEngine, subtitle } from './export-helpers.js';
import { call, createUser, GB, login, setLimit, type TestApp, testApp, testDb } from './helpers.js';

/**
 * Exports through the API (docs/04-api.md, "匯出"; docs/10-storage.md, phase 7). No media service
 * here, so every export stays queued unless a test moves it; the mux itself is in exports-mux.test.ts.
 */
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let meiId: string;
let haoId: string;
let mei: string;
let hao: string;
let boss: string;
let strangerCookie: string;
let dataDir: string;

const start = (cookie: string, tid: string, body: unknown) =>
  call(t.app, 'POST', `/api/torrents/${tid}/exports`, { cookie, body });
const exp = async (id: string) => (await db.pool.query('select * from exports where id = $1', [id])).rows[0];

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  dataDir = t.deps.config.dataDir;
  meiId = await createUser(db.pool, 'mei');
  haoId = await createUser(db.pool, 'hao');
  await createUser(db.pool, 'boss', 'admin');
  await createUser(db.pool, 'stranger');
  mei = await login(t.app, 'mei');
  hao = await login(t.app, 'hao');
  boss = await login(t.app, 'boss');
  strangerCookie = await login(t.app, 'stranger');
});
afterAll(async () => {
  await t?.app.close();
  await db?.drop();
});
beforeEach(async () => {
  await setLimit(db.pool, 100 * GB);
  t.disk.availableBytes = 900 * GB;
});

describe('starting an export', () => {
  it('writes the final SRTs now, default first, and reserves the film size × 1.01 + 1 MB', async () => {
    const f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId, haoId]);
    const edited = SyncCore.identityDoc();
    edited.segments = [{ from: 0, scale: 1, offset: 1.5 }];
    edited.edits = { '2': { deleted: true } };
    const en = await subtitle(db.pool, dataDir, f.tid, 'truth.en.srt', { language: 'en', doc: edited });
    const zh = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
    const before = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage.usedBytes;
    const res = await start(mei, f.tid, {
      fileName: 'Clip.2026.1080p.zh-TW.mkv',
      tracks: [
        { subtitleId: en.id, isDefault: false },
        { subtitleId: zh.id, isDefault: true },
      ],
    });
    expect(res.statusCode).toBe(201);
    const e = res.json();
    expect(e).toMatchObject({
      torrentId: f.tid,
      fileName: 'Clip.2026.1080p.zh-TW.mkv',
      state: 'queued',
      downloadUrl: null,
      canDelete: true,
      createdBy: { id: meiId },
      tracks: [
        { language: 'zh-Hant', title: '繁體中文', isDefault: true },
        { language: 'en', title: 'English', isDefault: false },
      ],
    });
    const row = await exp(e.id);
    const size = (await readFile(fixture('clip.mp4'))).length;
    expect(row.reserved_bytes).toBe(exportNeedBytes(size));
    expect(row.reserved_bytes).toBe(Math.ceil(size * 1.01) + 1024 * 1024);
    expect(row.tracks.map((x: { rev: number }) => x.rev)).toEqual([3, 3]);
    const dir = join(dataDir, 'exports', e.id, 'tracks');
    expect(await readFile(join(dir, '0.srt'), 'utf8')).toBe(SyncCore.toSrt(SyncCore.applyDoc(zh.cues, zh.doc)));
    const enSrt = await readFile(join(dir, '1.srt'), 'utf8');
    expect(enSrt).toBe(SyncCore.toSrt(SyncCore.applyDoc(en.cues, edited)));
    expect(enSrt).not.toContain('I thought you did.'); // the deleted line
    expect(enSrt).toContain('00:00:04,450 --> 00:00:06,736'); // moved by 1.5 s
    const after = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage;
    expect(after.usedBytes - before).toBe(row.reserved_bytes);
    const task = (await db.pool.query(`select * from tasks where kind = 'export' and input->>'exportId' = $1`, [e.id]))
      .rows[0];
    expect(task).toMatchObject({ state: 'queued', subject: { movieTitle: row.movie_title, fileName: row.file_name } });
    expect(
      (await db.pool.query('select last_used_at from torrents where id = $1', [f.tid])).rows[0].last_used_at,
    ).not.toBe(null);
    const log = (await db.pool.query(`select target from audit_log where action = 'export.create'`)).rows;
    expect(log).toContainEqual({ target: { movieTitle: row.movie_title, fileName: row.file_name } });
    // Another holder sees it in the workspace, without the right to delete it.
    const seen = await exportsForTorrent(t.deps, f.tid, haoId);
    expect(seen.map((x) => [x.id, x.canDelete])).toEqual([[e.id, false]]);
  });

  it('refuses tracks that are missing, unconfirmed or of another film', async () => {
    const f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    const other = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    const draft = await subtitle(db.pool, dataDir, f.tid, 'truth.en.srt', { language: 'en', status: 'draft' });
    const ok = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
    const foreign = await subtitle(db.pool, dataDir, other.tid, 'truth.zh-TW.srt');
    const code = async (tracks: unknown, fileName = 'a.mkv') => (await start(mei, f.tid, { fileName, tracks })).json();
    expect((await code([])).error.code).toBe('NO_CONFIRMED_SUBTITLE');
    expect((await code([{ subtitleId: draft.id, isDefault: true }])).error.code).toBe('NO_CONFIRMED_SUBTITLE');
    expect(
      (
        await code([
          { subtitleId: ok.id, isDefault: true },
          { subtitleId: foreign.id, isDefault: false },
        ])
      ).error.code,
    ).toBe('NO_CONFIRMED_SUBTITLE');
    const twoDefaults = await code([
      { subtitleId: ok.id, isDefault: true },
      { subtitleId: draft.id, isDefault: true },
    ]);
    expect(twoDefaults.error).toMatchObject({ code: 'VALIDATION', details: { fields: { tracks: 'ONE_DEFAULT' } } });
    expect((await code([{ subtitleId: ok.id, isDefault: false }])).error.code).toBe('VALIDATION');
    expect(
      (
        await code([
          { subtitleId: ok.id, isDefault: true },
          { subtitleId: ok.id, isDefault: false },
        ])
      ).error.details.fields.tracks,
    ).toBe('DUPLICATE');
    expect((await code([{ subtitleId: 'not-a-uuid', isDefault: true }])).error.code).toBe('VALIDATION');
    expect(
      (await db.pool.query('select count(*)::int as n from exports where torrent_id = $1', [f.tid])).rows[0].n,
    ).toBe(0);
  });

  it('checks the file name like the schema does', async () => {
    const f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    const s = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
    const reason = async (fileName: string) => {
      const r = (await start(mei, f.tid, { fileName, tracks: [{ subtitleId: s.id, isDefault: true }] })).json();
      return r.error?.code === 'INVALID_FILENAME' ? r.error.details.fields.fileName : (r.error?.code ?? 'OK');
    };
    expect(await reason('movie.mp4')).toBe('EXTENSION');
    expect(await reason('.mkv')).toBe('EXTENSION');
    expect(await reason('a/b.mkv')).toBe('CHARACTERS');
    expect(await reason('a\\b.mkv')).toBe('CHARACTERS');
    expect(await reason('what?.mkv')).toBe('CHARACTERS');
    expect(await reason('line\nbreak.mkv')).toBe('CHARACTERS');
    expect(await reason(`${'長'.repeat(197)}.mkv`)).toBe('TOO_LONG');
    expect(await reason(`${'長'.repeat(196)}.MKV`)).toBe('OK');
    expect(await reason('片名.2026.1080p.zh-TW.mkv')).toBe('OK');
  });

  it('is for holders of a finished film only, administrators included', async () => {
    const f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    const s = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
    const body = { fileName: 'a.mkv', tracks: [{ subtitleId: s.id, isDefault: true }] };
    expect((await start(hao, f.tid, body)).json().error.code).toBe('NOT_HOLDER');
    expect((await start(boss, f.tid, body)).json().error.code).toBe('NOT_HOLDER');
    expect((await call(t.app, 'POST', `/api/torrents/${f.tid}/exports`, { body })).statusCode).toBe(401);
    const busy = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId], { state: 'downloading' });
    expect((await start(mei, busy.tid, body)).json().error.code).toBe('MEDIA_NOT_READY');
  });

  it('needs room, also after the limit was set below what is used, and leaves nothing behind', async () => {
    const f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    const s = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
    const body = { fileName: 'a.mkv', tracks: [{ subtitleId: s.id, isDefault: true }] };
    const need = exportNeedBytes((await readFile(fixture('clip.mp4'))).length);
    const used = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage.usedBytes;
    await setLimit(db.pool, used + need - 1);
    const short = (await start(mei, f.tid, body)).json();
    expect(short.error).toMatchObject({ code: 'STORAGE_LIMIT', details: { needBytes: need, shortBytes: 1 } });
    await setLimit(db.pool, Math.floor(used / 2));
    expect((await start(mei, f.tid, body)).json().error.code).toBe('STORAGE_LIMIT');
    await setLimit(db.pool, 100 * GB);
    t.disk.availableBytes = 2 * GB; // only the reserve left on the disk itself
    const full = await start(mei, f.tid, body);
    expect(full.statusCode).toBe(507);
    expect(full.json().error.code).toBe('DISK_FULL');
    const rows = (await db.pool.query('select count(*)::int as n from exports where torrent_id = $1', [f.tid])).rows[0];
    expect(rows.n).toBe(0);
    const left = await readdir(join(dataDir, 'exports')).catch(() => [] as string[]);
    const known = (await db.pool.query('select id::text from exports')).rows.map((r) => r.id);
    expect(left.filter((d) => !known.includes(d))).toEqual([]);
    t.disk.availableBytes = 900 * GB;
    await setLimit(db.pool, used + need);
    expect((await start(mei, f.tid, body)).statusCode).toBe(201);
  });
});

/** Turns a queued export into a finished one with `content` as its MKV, as the mux job would. */
async function finish(id: string, content: Buffer): Promise<void> {
  const row = await exp(id);
  await mkdir(join(dataDir, 'exports', id), { recursive: true });
  await writeFile(join(dataDir, 'exports', id, row.file_name), content);
  await db.pool.query(
    `update exports set state = 'done', size_bytes = $2, reserved_bytes = 0, progress = 1, rel_path = $3, completed_at = now() where id = $1`,
    [id, content.length, `exports/${id}/${row.file_name}`],
  );
}

describe('the export list, file and deletion', () => {
  let f: Awaited<ReturnType<typeof film>>;
  let s: { id: string };
  beforeEach(async () => {
    f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId, haoId]);
    s = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
  });
  const make = async (cookie = mei, fileName = '片名 2026.mkv') =>
    (await start(cookie, f.tid, { fileName, tracks: [{ subtitleId: s.id, isDefault: true }] })).json();

  it('lists one’s own exports; the whole site only for administrators', async () => {
    const mine = await make();
    const his = await make(hao, 'his.mkv');
    const list = (await call(t.app, 'GET', '/api/exports', { cookie: mei })).json();
    expect(list.map((x: { id: string }) => x.id)).toContain(mine.id);
    expect(list.map((x: { id: string }) => x.id)).not.toContain(his.id);
    expect((await call(t.app, 'GET', '/api/exports?scope=all', { cookie: mei })).json().error.code).toBe('FORBIDDEN');
    const all = (await call(t.app, 'GET', '/api/exports?scope=all', { cookie: boss })).json();
    expect(all.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([mine.id, his.id]));
    expect(all.every((x: { canDelete: boolean }) => x.canDelete)).toBe(true);
  });

  it('downloads with Range and a UTF-8 file name, for holders, the creator and administrators', async () => {
    const e = await make();
    expect((await call(t.app, 'GET', `/api/exports/${e.id}/file`, { cookie: mei })).statusCode).toBe(404);
    const content = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    await finish(e.id, content);
    const whole = await call(t.app, 'GET', `/api/exports/${e.id}/file`, { cookie: mei });
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(content)).toBe(true);
    expect(whole.headers['content-type']).toBe('video/x-matroska');
    expect(whole.headers['content-disposition']).toBe(
      `attachment; filename="__ 2026.mkv"; filename*=UTF-8''${encodeURIComponent('片名 2026.mkv')}`,
    );
    // A download that stopped at 1234 bytes resumes from there.
    const rest = await call(t.app, 'GET', `/api/exports/${e.id}/file`, {
      cookie: hao,
      headers: { range: 'bytes=1234-' },
    });
    expect(rest.statusCode).toBe(206);
    expect(rest.headers['content-range']).toBe(`bytes 1234-4999/5000`);
    expect(Buffer.concat([content.subarray(0, 1234), rest.rawPayload]).equals(content)).toBe(true);
    expect((await call(t.app, 'GET', `/api/exports/${e.id}/file`, { cookie: boss })).statusCode).toBe(200);
    expect((await call(t.app, 'GET', `/api/exports/${e.id}/file`, { cookie: strangerCookie })).statusCode).toBe(404);
    const listed = (await call(t.app, 'GET', '/api/exports', { cookie: mei }))
      .json()
      .find((x: { id: string }) => x.id === e.id);
    expect(listed).toMatchObject({ state: 'done', sizeBytes: 5000, downloadUrl: `/api/exports/${e.id}/file` });
  });

  it('deletes a waiting export with its tracks and task, by its creator or an administrator only', async () => {
    const e = await make();
    const dir = join(dataDir, 'exports', e.id);
    expect(await exists(join(dir, 'tracks', '0.srt'))).toBe(true);
    expect((await call(t.app, 'DELETE', `/api/exports/${e.id}`, { cookie: hao })).json().error.code).toBe('FORBIDDEN');
    expect((await call(t.app, 'DELETE', `/api/exports/${e.id}`, { cookie: strangerCookie })).statusCode).toBe(404);
    const reserved = (await exp(e.id)).reserved_bytes;
    const res = await call(t.app, 'DELETE', `/api/exports/${e.id}`, { cookie: mei });
    expect(res.json()).toEqual({ freedBytes: reserved });
    expect(await exp(e.id)).toBeUndefined();
    expect(await exists(dir)).toBe(false);
    const task = await db.pool.query(`select state from tasks where input->>'exportId' = $1`, [e.id]);
    expect(task.rows).toEqual([{ state: 'cancelled' }]);
    const other = await make(hao, 'b.mkv');
    await finish(other.id, Buffer.alloc(300));
    expect((await call(t.app, 'DELETE', `/api/exports/${other.id}`, { cookie: boss })).json()).toEqual({
      freedBytes: 300,
    });
    expect(await exists(join(dataDir, 'exports', other.id))).toBe(false);
    const log = (await db.pool.query(`select target from audit_log where action = 'export.delete'`)).rows;
    expect(log).toContainEqual({ target: { fileName: '片名 2026.mkv' } });
  });

  it('asks a running export to stop and hides it from then on', async () => {
    const e = await make();
    await db.pool.query(`update exports set state = 'running' where id = $1`, [e.id]);
    const res = await call(t.app, 'DELETE', `/api/exports/${e.id}`, { cookie: mei });
    expect(res.json().freedBytes).toBe((await exp(e.id)).reserved_bytes);
    expect((await exp(e.id)).cancel_requested).toBe(true);
    expect(await exists(join(dataDir, 'exports', e.id, 'tracks'))).toBe(true); // the media service removes it
    const list = (await call(t.app, 'GET', '/api/exports', { cookie: mei })).json();
    expect(list.map((x: { id: string }) => x.id)).not.toContain(e.id);
    expect((await call(t.app, 'DELETE', `/api/exports/${e.id}`, { cookie: mei })).statusCode).toBe(404);
  });
});

describe('when the film is removed', () => {
  let engine: Engine;
  let worker: TorrentWorker;
  beforeAll(async () => {
    // The stand-in engine downloads nothing: keep the loop from starting the unfinished films above.
    await db.pool.query(`update torrents set state = 'paused', want = 'pause' where state = 'downloading'`);
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
    await engine?.destroy();
  });

  it('keeps finished exports downloadable and fails waiting ones with SOURCE_MISSING, tracks gone', async () => {
    const f = await film(db.pool, dataDir, fixture('clip.mp4'), [meiId]);
    const s = await subtitle(db.pool, dataDir, f.tid, 'truth.zh-TW.srt');
    const body = (fileName: string) => ({ fileName, tracks: [{ subtitleId: s.id, isDefault: true }] });
    const done = (await start(mei, f.tid, body('done.mkv'))).json();
    const waiting = (await start(mei, f.tid, body('waiting.mkv'))).json();
    const content = Buffer.from('a finished export');
    await finish(done.id, content);
    expect((await call(t.app, 'DELETE', `/api/torrents/${f.tid}/hold`, { cookie: mei })).statusCode).toBe(200);
    await worker.tick();
    expect(await exists(join(dataDir, 'torrents', f.hash))).toBe(false);

    const kept = await exp(done.id);
    expect(kept).toMatchObject({ state: 'done', torrent_id: null });
    const file = await call(t.app, 'GET', `/api/exports/${done.id}/file`, { cookie: mei });
    expect(file.rawPayload.equals(content)).toBe(true);

    const failed = await exp(waiting.id);
    expect(failed).toMatchObject({
      state: 'failed',
      error_code: 'SOURCE_MISSING',
      reserved_bytes: 0,
      torrent_id: null,
    });
    expect(await exists(join(dataDir, 'exports', waiting.id))).toBe(false);
    const task = await db.pool.query(`select state, error_code from tasks where input->>'exportId' = $1`, [waiting.id]);
    expect(task.rows).toEqual([{ state: 'failed', error_code: 'SOURCE_MISSING' }]);
    const notes = (
      await db.pool.query(`select kind, data from notifications where user_id = $1 and kind = 'export.failed'`, [meiId])
    ).rows;
    expect(notes).toContainEqual({
      kind: 'export.failed',
      data: { movieTitle: failed.movie_title, fileName: 'waiting.mkv', errorCode: 'SOURCE_MISSING' },
    });
    const list = (await call(t.app, 'GET', '/api/exports', { cookie: mei })).json();
    expect(list.find((x: { id: string }) => x.id === done.id)).toMatchObject({ torrentId: null, state: 'done' });
    // The failed one can still be deleted by its creator; nothing to free.
    expect((await call(t.app, 'DELETE', `/api/exports/${waiting.id}`, { cookie: mei })).json()).toEqual({
      freedBytes: 0,
    });
  });
});
