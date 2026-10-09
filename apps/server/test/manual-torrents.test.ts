import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Seeded, type Seeder, startSeeder } from '@paiban/fakes/seed';
import { type FakeSources, startFakeSources } from '@paiban/fakes/subtitles';
import type { FastifyInstance } from 'fastify';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../src/torrent/engine.js';
import { Inspector } from '../src/torrent/inspector.js';
import { TorrentWorker } from '../src/torrent/worker.js';
import { titleGuess } from '../src/torrents/manual-routes.js';
import { call, createUser, GB, login, PUBLIC_URL, setLimit, type TestApp, testApp, testDb } from './helpers.js';

/**
 * Torrents added by hand (Brian, 2026-10-09; D26 changed; docs/06-torrent-worker.md, "手動加入"):
 * a .torrent file or a magnet link against a WebTorrent seeder on 127.0.0.1, the film from the
 * local fake TMDB. No network beyond loopback.
 */
const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));
const sha = async (p: string) =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
const CITIZEN_KANE = 15; // the fake TMDB's film that YTS does not list

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let fake: FakeSources;
let seeder: Seeder;
let pack: Seeded;
let lonely: Seeded;
let subsOnly: Seeded;
let engine: Engine;
let worker: TorrentWorker;
let mei: string;
let hao: string;
let boss: string;
const port = () => 53_000 + Math.floor(Math.random() * 5000);

function upload(app: FastifyInstance, content: Buffer, cookie: string, name = 'release.torrent') {
  const boundary = `----paiban${Math.random().toString(16).slice(2)}`;
  return app.inject({
    method: 'POST',
    url: '/api/torrents/inspect',
    headers: {
      cookie,
      'x-requested-with': 'paiban',
      origin: PUBLIC_URL,
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}

async function until(check: () => Promise<boolean>, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await worker.tick();
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('condition not met in time');
}

beforeAll(async () => {
  db = await testDb();
  fake = await startFakeSources();
  t = await testApp(db.pool, { sourceOverrides: fake.overrides, allowLocalSources: true });
  seeder = await startSeeder([
    {
      name: 'Citizen.Kane.1941.1080p.BluRay.x265',
      files: [fixture('clip.mp4'), fixture('clip.hevc10.mp4'), fixture('truth.en.srt')],
    },
    fixture('clip.webm'),
    { name: 'Only.Subtitles', files: [fixture('truth.en.srt'), fixture('truth.zh-TW.srt')] },
  ]);
  [pack, lonely, subsOnly] = seeder.seeded as [Seeded, Seeded, Seeded];
  await createUser(db.pool, 'boss', 'admin');
  await createUser(db.pool, 'mei');
  await createUser(db.pool, 'hao');
  boss = await login(t.app, 'boss');
  mei = await login(t.app, 'mei');
  hao = await login(t.app, 'hao');
  await call(t.app, 'PUT', '/api/admin/secrets/tmdbKey', { cookie: boss, body: { value: 'tmdb-test-key-not-real' } });
  await setLimit(db.pool, 100 * GB);
  engine = createEngine({ torrentPort: port(), dhtPort: port(), downloadLimit: 0, uploadLimit: 0, offline: true });
  worker = new TorrentWorker({
    pool: db.pool,
    config: { ...t.deps.config, torrentTestPeers: [`127.0.0.1:${seeder.port}`] },
    log: pino({ level: 'silent' }),
    engine,
    disk: t.deps.disk,
  });
});
afterAll(async () => {
  await worker?.shutdown(); // destroys the engine too
  await seeder?.close();
  await fake?.close();
  await t?.app.close();
  await db?.drop();
});

describe('a .torrent file', () => {
  it('shows what will be downloaded: the largest video file only', async () => {
    const res = await upload(t.app, pack.torrentFile, mei);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      source: 'file',
      infoHash: pack.hash,
      state: 'ready',
      errorCode: null,
      name: 'Citizen.Kane.1941.1080p.BluRay.x265',
      file: {
        path: expect.stringMatching(/clip\.hevc10\.mp4$/),
        sizeBytes: (await stat(fixture('clip.hevc10.mp4'))).size,
      },
      subtitleFiles: 1,
      skippedFiles: 1,
      version: { quality: '1080p', source: 'bluray', videoCodec: 'x265' },
      guess: { title: 'Citizen Kane', year: 1941 },
      existing: null,
    });
    // Nobody else reads it.
    expect((await call(t.app, 'GET', `/api/torrents/inspect/${res.json().id}`, { cookie: hao })).statusCode).toBe(404);
  });

  it('adds it as the film picked on TMDB, and downloads only that file', async () => {
    const ins = (await upload(t.app, pack.torrentFile, mei)).json();
    const before = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage.usedBytes;
    const res = await call(t.app, 'POST', '/api/torrents/manual', {
      cookie: mei,
      body: { inspectionId: ins.id, tmdbId: CITIZEN_KANE },
    });
    expect(res.statusCode).toBe(201);
    const torrent = res.json().torrent;
    // The video and the subtitle file beside it: both are downloaded, so both are admitted.
    const size = (await stat(fixture('clip.hevc10.mp4'))).size + (await stat(fixture('truth.en.srt'))).size;
    expect(res.json().joined).toBe(false);
    expect(torrent).toMatchObject({
      origin: 'manual',
      movie: { ytsId: null, title: 'Citizen Kane', titleZh: '大國民', year: 1941, runtimeMin: 110 },
      version: { quality: '1080p', videoCodec: 'x265' },
      sizeBytes: size,
      mine: true,
    });
    expect(torrent.movie.posterUrl).toMatch(/^\/api\/movies\/[0-9a-f-]{36}\/poster$/);
    // Admission counted the video file and its preview, not the whole torrent.
    const after = (await call(t.app, 'GET', '/api/storage', { cookie: mei })).json().usage.usedBytes;
    expect(after - before).toBeGreaterThanOrEqual(size);
    // Used up.
    expect((await call(t.app, 'GET', `/api/torrents/inspect/${ins.id}`, { cookie: mei })).statusCode).toBe(404);
    const logged = await db.pool.query(`select target from audit_log where action = 'torrent.manual'`);
    expect(logged.rows[0]?.target).toMatchObject({ movieTitle: 'Citizen Kane' });

    await until(
      async () =>
        (await db.pool.query('select state from torrents where id = $1', [torrent.id])).rows[0].state === 'completed',
    );
    const dir = join(t.deps.config.dataDir, 'torrents', pack.hash, pack.name);
    expect(await sha(join(dir, 'clip.hevc10.mp4'))).toBe(await sha(fixture('clip.hevc10.mp4')));
    // The other video was not downloaded (at most the pieces it shares with the chosen one).
    const other = await stat(join(dir, 'clip.mp4')).then(
      (s) => s.size,
      () => 0,
    );
    const whole = (await stat(fixture('clip.mp4'))).size;
    expect(await sha(join(dir, 'clip.mp4')).catch(() => '')).not.toBe(await sha(fixture('clip.mp4')));
    expect(other).toBeLessThanOrEqual(whole);
    // The subtitle file beside it came too (it becomes a subtitle once the media service probes the film).
    expect(await sha(join(dir, 'truth.en.srt'))).toBe(await sha(fixture('truth.en.srt')));
    const media = (await db.pool.query('select rel_path from media_files where torrent_id = $1', [torrent.id])).rows[0];
    expect(media.rel_path).toMatch(/clip\.hevc10\.mp4$/);

    // The poster is kept from TMDB and served by this server.
    await until(
      async () => (await call(t.app, 'GET', torrent.movie.posterUrl, { cookie: mei })).statusCode === 200,
      10_000,
    );
  });

  it('joins when the same torrent is already on the site', async () => {
    const ins = (await upload(t.app, pack.torrentFile, hao)).json();
    expect(ins.existing).toMatchObject({ infoHash: pack.hash, mine: false });
    const res = await call(t.app, 'POST', '/api/torrents/manual', {
      cookie: hao,
      body: { inspectionId: ins.id, tmdbId: CITIZEN_KANE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ joined: true, torrent: { mine: true } });
  });

  it('refuses a file that is not a torrent, and one without a video', async () => {
    const bad = await upload(t.app, Buffer.from('not a torrent'), mei);
    expect(bad.json().error).toMatchObject({ code: 'TORRENT_INVALID', details: { reason: 'BAD_TORRENT' } });
    const subs = (await upload(t.app, subsOnly.torrentFile, mei)).json();
    expect(subs).toMatchObject({ state: 'failed', errorCode: 'NO_VIDEO_FILE', file: null });
    const res = await call(t.app, 'POST', '/api/torrents/manual', {
      cookie: mei,
      body: { inspectionId: subs.id, tmdbId: CITIZEN_KANE },
    });
    expect(res.json().error).toMatchObject({ code: 'TORRENT_INVALID', details: { reason: 'NO_VIDEO_FILE' } });
  });
});

describe('a magnet link', () => {
  it('waits for the swarm to hand over the metadata, in memory only', async () => {
    const res = await call(t.app, 'POST', '/api/torrents/inspect', {
      cookie: mei,
      body: {
        magnet: `magnet:?xt=urn:btih:${lonely.hash}&dn=whatever&tr=${encodeURIComponent('http://127.0.0.1:1/announce')}`,
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ source: 'magnet', state: 'pending', file: null, name: null });
    const row = await db.pool.query('select trackers from torrent_inspections where id = $1', [res.json().id]);
    expect(row.rows[0].trackers).toEqual([]); // a loopback tracker is dropped
    const inspector = new Inspector(
      db.pool,
      engine,
      { ...t.deps.config, torrentTestPeers: [`127.0.0.1:${seeder.port}`] },
      pino({ level: 'silent' }),
      30_000,
    );
    const id = res.json().id;
    await until(async () => {
      await inspector.tick();
      return (await call(t.app, 'GET', `/api/torrents/inspect/${id}`, { cookie: mei })).json().state !== 'pending';
    });
    expect((await call(t.app, 'GET', `/api/torrents/inspect/${id}`, { cookie: mei })).json()).toMatchObject({
      state: 'ready',
      file: { path: 'clip.webm' },
      skippedFiles: 0,
    });
    expect(engine.has(lonely.hash)).toBe(false);
  });

  it('says so when the swarm never answers', async () => {
    const res = await call(t.app, 'POST', '/api/torrents/inspect', {
      cookie: mei,
      body: { magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}` },
    });
    const inspector = new Inspector(
      db.pool,
      engine,
      { ...t.deps.config, torrentTestPeers: [] },
      pino({ level: 'silent' }),
      500,
    );
    const id = res.json().id;
    await until(async () => {
      await inspector.tick();
      return (await call(t.app, 'GET', `/api/torrents/inspect/${id}`, { cookie: mei })).json().state !== 'pending';
    }, 10_000);
    expect((await call(t.app, 'GET', `/api/torrents/inspect/${id}`, { cookie: mei })).json()).toMatchObject({
      state: 'failed',
      errorCode: 'NO_METADATA',
    });
  });

  it('refuses what is not a BitTorrent magnet link', async () => {
    for (const magnet of ['https://example.com/a.torrent', 'magnet:?xt=urn:ed2k:abc'])
      expect(
        (await call(t.app, 'POST', '/api/torrents/inspect', { cookie: mei, body: { magnet } })).json().error,
      ).toMatchObject({ code: 'TORRENT_INVALID', details: { reason: 'BAD_MAGNET' } });
  });

  it('limits how many one person inspects in an hour', async () => {
    const userId = (await db.pool.query(`select id from users where username = 'hao'`)).rows[0].id;
    await db.pool.query(
      `insert into torrent_inspections (created_by, source, info_hash, state)
       select $1, 'magnet', lpad(to_hex(g), 40, '0'), 'failed' from generate_series(1, 30) g`,
      [userId],
    );
    const res = await call(t.app, 'POST', '/api/torrents/inspect', {
      cookie: hao,
      body: { magnet: `magnet:?xt=urn:btih:${'d'.repeat(40)}` },
    });
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('reading a release name', () => {
  it('takes the title and year in front of the version words', () => {
    expect(titleGuess('Night.of.the.Living.Dead.1968.1080p.BluRay.x264-GRP')).toEqual({
      title: 'Night of the Living Dead',
      year: 1968,
    });
    expect(titleGuess('Blade Runner 2049 (2017) [2160p] [4K] [WEB]')).toEqual({
      title: 'Blade Runner 2049',
      year: 2017,
    });
    expect(titleGuess('home_video.mp4')).toEqual({ title: 'home video', year: null });
  });
});
