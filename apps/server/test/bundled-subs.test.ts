import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBundledSubtitles, subtitleFilesIn, textTracks } from '../src/media/bundled-subs.js';
import type { JobDeps } from '../src/media/jobs.js';
import { film, fixture } from './export-helpers.js';
import { createUser, type TestApp, testApp, testDb } from './helpers.js';

/**
 * Subtitles a download carries (Brian, 2026-10-09; docs/08-media-pipeline.md, "Subtitles from the torrent"):
 * files beside the film and text tracks inside it become the film's subtitles.
 */
const FFMPEG = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let d: JobDeps;
let meiId: string;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  d = { pool: db.pool, config: t.deps.config, log: pino({ level: 'silent' }), disk: t.deps.disk };
  meiId = await createUser(db.pool, 'mei');
});
afterAll(async () => {
  await t?.app.close();
  await db?.drop();
});

const rows = async (tid: string) =>
  (
    await db.pool.query(
      'select provider, provider_ref, release_name, language, converted_s2t, status, added_by, cue_count from subtitles where torrent_id = $1 order by provider_ref',
      [tid],
    )
  ).rows;

describe('subtitles that come with a download', () => {
  it('reads the text subtitle tracks of an ffprobe answer, not picture ones', () => {
    expect(
      textTracks({
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264' },
          { index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng', title: 'SDH' } },
          { index: 3, codec_type: 'subtitle', codec_name: 'hdmv_pgs_subtitle', tags: { language: 'chi' } },
          { index: 4, codec_type: 'subtitle', codec_name: 'ass', tags: { LANGUAGE: 'und' } },
        ],
      }),
    ).toEqual([
      { index: 2, codec: 'subrip', language: 'eng', title: 'SDH' },
      { index: 4, codec: 'ass', language: null, title: null },
    ]);
    expect(textTracks('nonsense')).toEqual([]);
  });

  it('adds the files beside the film as draft subtitles, Simplified made Traditional, once', async () => {
    const f = await film(db.pool, d.config.dataDir, fixture('clip.mp4'), [meiId]);
    const root = join(d.config.dataDir, 'torrents', f.hash);
    await mkdir(join(root, 'Subs'), { recursive: true });
    await copyFile(fixture('truth.en.srt'), join(root, 'Subs', 'English.srt'));
    await copyFile(fixture('late.zh-CN.srt'), join(root, 'Subs', 'Chinese.srt'));
    await copyFile(fixture('clip.npz'), join(root, 'Subs', 'not-a-subtitle.npz'));
    expect((await subtitleFilesIn(root)).map((x) => x.path)).toEqual([
      join('Subs', 'Chinese.srt'),
      join('Subs', 'English.srt'),
    ]);
    const src = join(root, f.name);
    expect(
      await addBundledSubtitles(d, { id: f.mid, torrent_id: f.tid, info_hash: f.hash, rel_path: f.name }, src, {}),
    ).toBe(2);
    expect(await rows(f.tid)).toEqual([
      expect.objectContaining({
        provider: 'bundled',
        provider_ref: 'file:Subs/Chinese.srt',
        release_name: 'Chinese.srt',
        language: 'zh-Hant',
        converted_s2t: true,
        status: 'draft',
        added_by: null,
      }),
      expect.objectContaining({ provider_ref: 'file:Subs/English.srt', language: 'en', converted_s2t: false }),
    ]);
    // Probing again adds nothing twice, and leaves no work folder behind.
    expect(
      await addBundledSubtitles(d, { id: f.mid, torrent_id: f.tid, info_hash: f.hash, rel_path: f.name }, src, {}),
    ).toBe(0);
    expect(await readdir(join(d.config.dataDir, 'tmp', 'work')).catch(() => [])).toEqual([]);
  });

  it('adds nothing for a film being removed', async () => {
    const f = await film(db.pool, d.config.dataDir, fixture('clip.mp4'), [meiId]);
    await copyFile(fixture('truth.en.srt'), join(d.config.dataDir, 'torrents', f.hash, 'English.srt'));
    await db.pool.query(`update torrents set want = 'remove' where id = $1`, [f.tid]);
    const src = join(d.config.dataDir, 'torrents', f.hash, f.name);
    expect(
      await addBundledSubtitles(d, { id: f.mid, torrent_id: f.tid, info_hash: f.hash, rel_path: f.name }, src, {}),
    ).toBe(0);
  });

  it.skipIf(!FFMPEG)('takes the text tracks out of the video with ffmpeg', async () => {
    const f = await film(db.pool, d.config.dataDir, fixture('clip.mp4'), [meiId]);
    const root = join(d.config.dataDir, 'torrents', f.hash);
    const mkv = join(root, 'clip.mkv');
    const mux = spawnSync('ffmpeg', [
      ...['-v', 'error', '-y', '-i', fixture('clip.mp4'), '-i', fixture('truth.en.srt')],
      ...['-map', '0', '-map', '1', '-c', 'copy', '-c:s', 'srt', '-metadata:s:s:0', 'language=eng', mkv],
    ]);
    expect(mux.status).toBe(0);
    const probe = JSON.parse(
      spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', mkv], { encoding: 'utf8' }).stdout,
    );
    const index = textTracks(probe)[0]?.index;
    expect(index).toBeGreaterThan(0);
    expect(
      await addBundledSubtitles(
        d,
        { id: f.mid, torrent_id: f.tid, info_hash: f.hash, rel_path: 'clip.mkv' },
        mkv,
        probe,
      ),
    ).toBe(1);
    expect(await rows(f.tid)).toEqual([
      expect.objectContaining({ provider_ref: `track:${index}`, release_name: `clip #${index} (eng)`, language: 'en' }),
    ]);
  });
});
