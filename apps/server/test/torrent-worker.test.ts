import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Seeder, startSeeder } from '@paiban/fakes/seed';
import type { LocalVersion } from '@paiban/fakes/yts';
import { type FakeYts, startFakeYts } from '@paiban/fakes/yts';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/torrent/engine.js';
import { TorrentWorker } from '../src/torrent/worker.js';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

/**
 * The torrent service against a real WebTorrent seeder on 127.0.0.1 (docs/06-torrent-worker.md,
 * "測試"). No DHT, no trackers, no network beyond loopback.
 */
const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));
const sha = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let yts: FakeYts;
let seeder: Seeder;
let mei: string;
let hao: string;
let clipHash: string;
const UNSEEDED = 'b'.repeat(40);

let engine: Engine;
let worker: TorrentWorker;
let clock = Date.now();
let dataDir = '';
const port = () => 52_000 + Math.floor(Math.random() * 5000);

function newWorker(): TorrentWorker {
  engine = createEngine({ torrentPort: port(), dhtPort: port(), downloadLimit: 0, uploadLimit: 0, offline: true });
  worker = new TorrentWorker({
    pool: db.pool,
    config: { ...t.deps.config, dataDir, torrentTestPeers: [`127.0.0.1:${seeder.port}`] },
    log: pino({ level: 'silent' }),
    engine,
    disk: t.deps.disk,
    now: () => clock,
  });
  return worker;
}

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    clock = Date.now() > clock ? Date.now() : clock;
    await worker.tick();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('condition not met in time');
}
const row = async () => (await db.pool.query('select * from torrents')).rows[0];

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  seeder = await startSeeder([fixture('clip.mp4')]);
  const clip = seeder.seeded[0];
  if (!clip) throw new Error('no seed');
  clipHash = clip.hash;
  const local: LocalVersion[] = [
    {
      ytsId: 2,
      quality: '1080p',
      type: 'bluray',
      videoCodec: 'x264',
      bitDepth: 8,
      audio: '2.0',
      hash: clip.hash,
      sizeBytes: clip.length,
    },
    {
      ytsId: 2,
      quality: '720p',
      type: 'bluray',
      videoCodec: 'x264',
      bitDepth: 8,
      audio: '2.0',
      hash: UNSEEDED,
      sizeBytes: 1_000_000,
    },
  ];
  yts = await startFakeYts({ local });
  await setSetting(db.pool, 'yts.baseUrl', yts.url);
  await createUser(db.pool, 'mei');
  await createUser(db.pool, 'hao');
  mei = await login(t.app, 'mei');
  hao = await login(t.app, 'hao');
});
afterAll(async () => {
  await seeder.close();
  await yts.close();
  await t.app.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('delete from notifications');
  await db.pool.query('delete from torrents');
  await db.pool.query('delete from movies');
  await db.pool.query(`delete from settings where key like 'downloads.%'`);
  await setLimit(db.pool, 10 * GB);
  clock = Date.now();
  dataDir = await mkdtemp(join(tmpdir(), 'paiban-torrent-'));
  newWorker();
});
afterEach(async () => {
  await worker.shutdown().catch(() => undefined);
});

const start = async (cookie: string, hash = clipHash) =>
  (await call(t.app, 'POST', '/api/torrents', { cookie, body: { ytsId: 2, infoHash: hash } })).json().torrent
    .id as string;

describe('the torrent service', () => {
  it('downloads by hash, verifies, records the media file and tells the holder', async () => {
    const id = await start(mei);
    await until(async () => (await row()).state === 'completed');
    const r = await row();
    expect(r).toMatchObject({ progress: 1, bitfield: null, preview_reserve_bytes: 0 });
    const file = join(dataDir, 'torrents', clipHash, 'clip.mp4');
    expect(await sha(file)).toBe(await sha(fixture('clip.mp4')));
    expect(r.disk_bytes).toBeGreaterThan(0);
    const media = (await db.pool.query('select rel_path, direct_play, analysis_state, audio_state from media_files'))
      .rows[0];
    expect(media).toEqual({ rel_path: 'clip.mp4', direct_play: true, analysis_state: 'none', audio_state: 'none' });
    const torrent = (await call(t.app, 'GET', `/api/torrents/${id}`, { cookie: mei })).json();
    expect(torrent.status).toBe('ready');
    const notes = (await call(t.app, 'GET', '/api/notifications', { cookie: mei })).json();
    expect(notes.items[0]).toMatchObject({
      kind: 'download.completed',
      data: { movieTitle: 'Charade' },
      link: { page: 'workspace', torrentId: id },
    });
    expect((await call(t.app, 'GET', '/api/library', { cookie: mei })).json()[0]).toMatchObject({ next: 'subtitles' });
    const usage = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage;
    expect(usage.categories).toMatchObject({ reserved: 0, movies: r.disk_bytes });
  });

  it('pauses for real, keeps the pieces, and resumes from them', async () => {
    await setSetting(db.pool, 'downloads.downloadLimitKB', 100);
    const id = await start(mei);
    await until(async () => (await row()).progress > 0.15);
    await call(t.app, 'POST', `/api/torrents/${id}/pause`, { cookie: mei });
    await until(async () => (await row()).state === 'paused');
    const paused = await row();
    expect(paused.clean_stop).toBe(true);
    expect(paused.bitfield).not.toBeNull();
    expect(worker.activeCount).toBe(0);
    await setSetting(db.pool, 'downloads.downloadLimitKB', 0);
    await call(t.app, 'POST', `/api/torrents/${id}/resume`, { cookie: mei });
    await until(async () => (await row()).state === 'completed');
    expect(await sha(join(dataDir, 'torrents', clipHash, 'clip.mp4'))).toBe(await sha(fixture('clip.mp4')));
  });

  it('continues after a clean restart of the service', async () => {
    await setSetting(db.pool, 'downloads.downloadLimitKB', 100);
    await start(mei);
    await until(async () => (await row()).progress > 0.15);
    await worker.shutdown();
    expect(await row()).toMatchObject({ state: 'downloading', clean_stop: true });
    await setSetting(db.pool, 'downloads.downloadLimitKB', 0);
    newWorker();
    await worker.recover();
    await until(async () => (await row()).state === 'completed');
  });

  it('re-verifies after a crash instead of trusting an old bitfield', async () => {
    await setSetting(db.pool, 'downloads.downloadLimitKB', 100);
    await start(mei);
    await until(async () => (await row()).progress > 0.15);
    await engine.destroy(); // the process dies: nothing saved
    await db.pool.query('update torrents set clean_stop = false');
    await setSetting(db.pool, 'downloads.downloadLimitKB', 0);
    newWorker();
    await worker.recover();
    expect((await row()).phase).toBe('verifying');
    await until(async () => (await row()).state === 'completed');
    expect(await sha(join(dataDir, 'torrents', clipHash, 'clip.mp4'))).toBe(await sha(fixture('clip.mp4')));
  });

  it('fails without metadata after five minutes, keeps the row, and can be retried', async () => {
    const id = await start(mei, UNSEEDED);
    await until(async () => (await row()).state === 'downloading');
    clock += 6 * 60_000;
    await worker.tick();
    const failed = await row();
    expect(failed).toMatchObject({ state: 'failed', error_code: 'METADATA_TIMEOUT' });
    const notes = (await call(t.app, 'GET', '/api/notifications', { cookie: mei })).json();
    expect(notes.items[0]).toMatchObject({ kind: 'download.failed', data: { errorCode: 'METADATA_TIMEOUT' } });
    const retried = await call(t.app, 'POST', `/api/torrents/${id}/retry`, { cookie: mei });
    expect(retried.json().status).toBe('queued');
  });

  it('starts no more than the site-wide limit and keeps the rest queued in order', async () => {
    await setSetting(db.pool, 'downloads.maxActive', 1);
    await setSetting(db.pool, 'downloads.maxPerUser', 1);
    await start(mei, UNSEEDED);
    const second = await start(hao);
    await worker.tick();
    const states = (await db.pool.query('select info_hash, state from torrents order by queued_at')).rows.map(
      (r) => r.state,
    );
    expect(states).toEqual(['downloading', 'queued']);
    const t2 = (await call(t.app, 'GET', `/api/torrents/${second}`, { cookie: hao })).json();
    expect(t2.queuePosition).toBe(1);
  });

  it('deletes everything when the last holder leaves, and nothing while another still holds it', async () => {
    const id = await start(mei);
    await start(hao);
    await until(async () => (await row()).state === 'completed');
    const folder = join(dataDir, 'torrents', clipHash);
    await call(t.app, 'DELETE', `/api/torrents/${id}/hold`, { cookie: mei });
    await worker.tick();
    expect(await exists(folder)).toBe(true);
    await call(t.app, 'DELETE', `/api/torrents/${id}/hold`, { cookie: hao });
    await worker.tick();
    expect(await exists(folder)).toBe(false);
    expect((await db.pool.query('select count(*)::int as n from torrents')).rows[0].n).toBe(0);
    expect((await db.pool.query('select count(*)::int as n from movies')).rows[0].n).toBe(0);
  });
});
