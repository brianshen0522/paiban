// npm ci && npm test
//
// Runs schema.sql in PGlite (PostgreSQL compiled to WebAssembly) and walks one film through its
// whole life to check the numbers the storage rules depend on. Port these cases to the project's
// integration tests against the real database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const GB = 1024 ** 3;
const G = (x) => Math.round(x * GB);
const db = new PGlite();
await db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
const one = async (q, p) => (await db.query(q, p)).rows[0];
const usage = async () => {
  const u = await one('select *, storage_used_bytes() as used_bytes from storage_usage');
  return Object.fromEntries(Object.entries(u).map(([k, v]) => [k.replace('_bytes', ''), +(Number(v) / GB).toFixed(2)]));
};
const admit = async (need, release = 0) => {
  const r = await one('select * from storage_admit($1, $2)', [G(need), G(release)]);
  return { ok: r.ok, short: +(Number(r.short_bytes) / GB).toFixed(2) };
};
const rejects = (q, p) => assert.rejects(() => db.query(q, p));

let brian, mei, movie, A, B, media, exported;

test('setup: a 10 GB limit, two people, one film', async () => {
  await db.query(`insert into settings (key, value) values ('storage.limitBytes', $1)`, [JSON.stringify(G(10))]);
  brian = (await one(`insert into users (username, display_name, password_hash, role) values ('brian', 'Brian', 'x', 'admin') returning id`)).id;
  mei = (await one(`insert into users (username, display_name, password_hash) values ('mei', '美玲', 'x') returning id`)).id;
  movie = (await one(`insert into movies (yts_id, imdb_code, title, year, runtime_min) values (1, 'tt0000001', 'Sample', 2020, 96) returning id`)).id;
  assert.deepEqual(await usage(), { movies: 0, previews: 0, reserved: 0, partial: 0, exports: 0, used: 0 });
});

test('a download counts its full size and preview reservation from the moment it is admitted', async () => {
  await db.exec('begin');
  assert.deepEqual(await admit(4.5), { ok: true, short: 0 });
  A = (await one(
    `insert into torrents (info_hash, movie_id, quality, size_bytes, preview_reserve_bytes, requested_by) values ($1, $2, '2160p', $3, $4, $5) returning id`,
    ['a'.repeat(40), movie, G(4), G(0.5), brian],
  )).id;
  await db.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2), ($1, $3)', [A, brian, mei]);
  await db.exec('commit');
  assert.equal((await usage()).reserved, 4.5);
  assert.deepEqual(await admit(6), { ok: false, short: 0.5 });
  assert.deepEqual(await admit(5.5), { ok: true, short: 0 }, 'exactly reaching the limit is allowed');
});

test('when the torrent turns out bigger than listed, the larger size counts', async () => {
  await db.query('update torrents set length_bytes = $2 where id = $1', [A, G(4.2)]);
  assert.equal((await usage()).reserved, 4.7);
});

test('on completion the measured size replaces the reservation; the preview reservation moves to the media row', async () => {
  await db.exec('begin');
  await db.query(`update torrents set state = 'completed', progress = 1, disk_bytes = $2, preview_reserve_bytes = 0, completed_at = now() where id = $1`, [A, G(4.21)]);
  media = (await one(
    `insert into media_files (torrent_id, rel_path, size_bytes, audio_state, proxy_state, proxy_res, reserve_bytes) values ($1, 'Sample/Sample.mkv', $2, 'pending', 'pending', '480p', $3) returning id`,
    [A, G(4.2), G(0.5)],
  )).id;
  await db.exec('commit');
  assert.deepEqual(await usage(), { movies: 4.21, previews: 0.5, reserved: 0, partial: 0, exports: 0, used: 4.71 });
  await db.query(
    `update media_files set analysis_state = 'ready', audio_state = 'ready', audio_bytes = $2, proxy_state = 'ready', proxy_bytes = $3, reserve_bytes = 0 where id = $1`,
    [media, G(0.08), G(0.3)],
  );
  assert.equal((await usage()).previews, 0.38, 'the unused part of the reservation is released');
});

test('a failed download counts what it left on disk; a retry swaps that for a full reservation', async () => {
  B = (await one(
    `insert into torrents (info_hash, movie_id, quality, size_bytes, state, disk_bytes, error_code) values ($1, $2, '1080p', $3, 'failed', $4, 'STALLED') returning id`,
    ['b'.repeat(40), movie, G(2), G(0.3)],
  )).id;
  assert.equal((await usage()).partial, 0.3);
  assert.deepEqual(await admit(2, 0.3), { ok: true, short: 0 });
  await db.query(`update torrents set state = 'queued', error_code = null where id = $1`, [B]);
  const u = await usage();
  assert.deepEqual([u.reserved, u.partial, u.used], [2, 0, 6.59]);
});

test('an export needs room for a second copy of the film', async () => {
  assert.deepEqual(await admit(4.21), { ok: false, short: 0.8 });
  await db.query(`update settings set value = $1 where key = 'storage.limitBytes'`, [JSON.stringify(G(12))]);
  assert.equal((await admit(4.21)).ok, true);
  await db.query(`insert into subtitles (torrent_id, provider, language, format, cue_count, rel_dir, sha256, doc) values ($1, 'justsubtitles', 'zh-Hant', 'srt', 1200, 'x', 'h', '{}')`, [A]);
  exported = (await one(
    `insert into exports (torrent_id, movie_title, version_label, file_name, tracks, reserved_bytes, created_by) values ($1, 'Sample', '2160p', 'Sample.2020.2160p.zh-TW.mkv', '[]', $2, $3) returning id`,
    [A, G(4.21), brian],
  )).id;
  assert.equal((await usage()).exports, 4.21);
  await db.query(`update exports set state = 'done', size_bytes = $2, reserved_bytes = 0, completed_at = now() where id = $1`, [exported, G(4.2)]);
  assert.equal((await usage()).exports, 4.2);
});

test('lowering the limit below usage blocks new work and deletes nothing', async () => {
  await db.query(`update settings set value = $1 where key = 'storage.limitBytes'`, [JSON.stringify(G(5))]);
  assert.equal((await admit(0.000001)).ok, false);
  assert.equal((await one('select count(*)::int as n from torrents')).n, 2);
  assert.equal((await one('select count(*)::int as n from exports')).n, 1);
});

test('removing an account keeps the film; deleting the film keeps the export', async () => {
  await db.query('delete from users where id = $1', [mei]);
  assert.equal((await one('select count(*)::int as n from torrent_holders where torrent_id = $1', [A])).n, 1);
  await db.query('delete from torrents where id = $1', [A]);
  const left = await one(`select (select count(*)::int from media_files) as media, (select count(*)::int from subtitles) as subtitles, (select torrent_id from exports where id = $1) as export_torrent`, [exported]);
  assert.deepEqual(left, { media: 0, subtitles: 0, export_torrent: null });
  assert.deepEqual(await usage(), { movies: 0, previews: 0, reserved: 2, partial: 0, exports: 4.2, used: 6.2 });
});

test('with no limit configured nothing may start', async () => {
  await db.query('delete from settings');
  assert.equal((await admit(0.000001)).ok, false);
});

test('the frozen preview plan and the request pacing', async () => {
  await rejects(`insert into torrents (info_hash, movie_id, quality, size_bytes, preview_proxy_res) values ($1, $2, '720p', 1, '1080p')`, ['c'.repeat(40), movie]);
  const C = (await one(
    `insert into torrents (info_hash, movie_id, quality, size_bytes, preview_reserve_bytes, preview_proxy_res) values ($1, $2, '1080p', 1, 1, '480p') returning id, preview_proxy_res`,
    ['c'.repeat(40), movie],
  ));
  assert.equal(C.preview_proxy_res, '480p');
  await db.query('delete from torrents where id = $1', [C.id]);
  // three callers asking for a slot one second apart get send times at least one second apart
  const slots = [];
  for (let i = 0; i < 3; i++) slots.push(new Date((await one(`select provider_take_slot('yify', 1000) as at`)).at).getTime());
  assert.ok(slots[1] - slots[0] >= 1000 && slots[2] - slots[1] >= 1000, `slots ${slots.map((t) => t - slots[0])}`);
  const other = new Date((await one(`select provider_take_slot('assrt', 3400) as at`)).at).getTime();
  assert.ok(other < slots[1], 'each source is paced on its own');
});

test('constraints refuse what the application must never store', async () => {
  await rejects(`insert into torrents (info_hash, movie_id, quality, size_bytes) values ($1, $2, '720p', 1)`, ['A'.repeat(40), movie]);
  await rejects(`insert into torrents (info_hash, movie_id, quality, size_bytes) values ($1, $2, '720p', 1)`, ['b'.repeat(40), movie]);
  await rejects(`insert into exports (movie_title, version_label, file_name, tracks) values ('x', 'y', 'a/b.mkv', '[]')`);
  await rejects(`insert into exports (movie_title, version_label, file_name, tracks) values ('x', 'y', 'a.mp4', '[]')`);
  await rejects(`insert into users (username, display_name, password_hash) values ('Brian', 'B', 'x')`);
  await rejects(`insert into invites (code, role, expires_at) values ('O0I1-ABCD', 'member', now())`);
  await rejects(`insert into secrets (name, nonce, ciphertext) values ('other', '\\x00', '\\x00')`);
  await db.query(`insert into invites (code, role, expires_at) values ('K7QF-2M9D', 'member', now())`);
  await rejects(`insert into tasks (kind) values ('proxy')`);
  await db.query(`insert into tasks (kind, subject, input) values ('preview', '{"movieTitle":"Sample"}', '{}')`);
  await rejects(`insert into storage_findings (kind, root, name) values ('orphan', 'tmp', 'x')`);
  await rejects(`insert into storage_findings (kind, root, name) values ('orphan', 'media', '../etc')`);
  await db.query(`insert into storage_findings (kind, root, name, bytes) values ('orphan', 'media', '0b6f0c1e-aaaa-bbbb-cccc-000000000001', 5)`);
  await rejects(`insert into subtitle_candidates (torrent_id, provider, provider_ref, fetch_state, fetch_error) values ($1, 'upload', 'x', 'failed', 'TIMEOUT')`, [B]);
  await db.query(`insert into subtitle_candidates (torrent_id, provider, provider_ref, fetch_state, fetch_error) values ($1, 'upload', 'x', 'failed', 'ARCHIVE_INVALID')`, [B]);
  await db.query(`insert into audit_log (actor_name, action, target) values ('Brian', 'admin.storage.limit', '{"fromBytes":1,"toBytes":2}')`);
  await rejects(`insert into source_health (source, state, code) values ('zimuku', 'ok', 'OK')`);
  await db.query(`insert into source_health (source, state, code, data) values ('yify', 'ok', 'OK', '{"rows":402}')`);
  const m = await one(`insert into media_files (torrent_id, rel_path, size_bytes) values ($1, 'a.mp4', 1) returning probe_state, analysis_state`, [B]);
  assert.deepEqual(m, { probe_state: 'pending', analysis_state: 'pending' });
});
