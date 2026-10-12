import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { CHECKPOINT_COUNT, type Cue, SyncCore, type SyncDoc } from '@paiban/shared';
import { z } from 'zod';
import { prefsOf } from '../auth/users.js';
import { one, pgCode, UNIQUE_VIOLATION } from '../db/pool.js';
import { removeOwnSubtitleOutput, removeWorkDir } from '../storage/remove.js';
import { subtitleDir, subtitleRel } from '../subtitles/store.js';
import { cuesToTraditional, parseSubtitleFile } from '../subtitles/text.js';
import { SUBTITLE_MAX_BYTES, SUBTITLE_MAX_FILES, subtitleFiles } from '../torrent/schedule.js';
import type { JobDeps, MediaRow } from './jobs.js';
import { run } from './proc.js';

/**
 * Subtitles a download carries (Brian, 2026-10-09; docs/08-media-pipeline.md, "Subtitles from the torrent"):
 * text subtitle files beside the film (.srt, .ass, .ssa, .vtt) and the text subtitle tracks inside
 * the video. Each one becomes a subtitle of the film, provider 'bundled', not confirmed yet, added
 * by nobody in particular. Runs once the probe has read the file; a duplicate (same cues) is
 * skipped, so probing again adds nothing twice. Picture subtitles (PGS, VobSub) cannot become text.
 */

/** Text subtitle codecs ffmpeg can write out as SRT or ASS. */
const TEXT_CODECS = ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
/** At most this many tracks are taken from one video. */
const MAX_TRACKS = 20;

const Streams = z.object({
  streams: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        codec_type: z.string().optional(),
        codec_name: z.string().optional(),
        tags: z.record(z.string(), z.string()).optional(),
      }),
    )
    .default([]),
});

export type EmbeddedTrack = { index: number; codec: string; language: string | null; title: string | null };

/** The text subtitle tracks of an ffprobe answer, in stream order. */
export function textTracks(probe: unknown): EmbeddedTrack[] {
  const parsed = Streams.safeParse(probe);
  if (!parsed.success) return [];
  return parsed.data.streams
    .filter((s) => s.codec_type === 'subtitle' && TEXT_CODECS.includes(s.codec_name ?? ''))
    .slice(0, MAX_TRACKS)
    .map((s) => {
      const tags = Object.fromEntries(Object.entries(s.tags ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      return {
        index: s.index,
        codec: s.codec_name ?? '',
        language: tags.language && tags.language !== 'und' ? tags.language.slice(0, 16) : null,
        title: tags.title ? tags.title.slice(0, 80) : null,
      };
    });
}

/** ISO 639-2 tags a track may carry, for tracks whose text does not say its language. */
const TAG_LANGUAGE: Record<string, string> = { eng: 'en', en: 'en', chi: 'zh', zho: 'zh', zh: 'zh' };

/** The text subtitle files under a download's folder: regular files only, in path order. */
export async function subtitleFilesIn(root: string): Promise<{ path: string; length: number }[]> {
  const found: { path: string; length: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    if (depth > 4 || found.length > SUBTITLE_MAX_FILES * 4) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) {
        const s = await lstat(p);
        if (s.isFile()) found.push({ path: relative(root, p), length: s.size });
      }
    }
  };
  await walk(root, 0);
  return subtitleFiles(found.sort((a, b) => a.path.localeCompare(b.path)));
}

type Found = { name: string; bytes: Buffer; ref: string; release: string; tagLanguage: string | null };

export async function addBundledSubtitles(
  d: JobDeps,
  row: Pick<MediaRow, 'id' | 'torrent_id' | 'info_hash' | 'rel_path'>,
  src: string,
  probe: unknown,
): Promise<number> {
  const { pool, config, log } = d;
  const root = join(config.dataDir, 'torrents', row.info_hash);
  const owner = await one<{ prefs: Record<string, unknown> | null }>(
    pool,
    `select u.prefs from torrents t left join users u on u.id = t.requested_by where t.id = $1 and t.want <> 'remove'`,
    [row.torrent_id],
  );
  if (!owner) return 0;
  const convert = prefsOf(owner.prefs ?? {}, ['zh-Hant']).convertToTraditional;
  const film = basename(row.rel_path, extname(row.rel_path));
  const work = join(config.dataDir, 'tmp', 'work', `bundled-${row.id}`);
  const found: Found[] = [];
  try {
    // Files beside the film. The film's own folder name is left out of the shown name.
    for (const f of await subtitleFilesIn(root)) {
      if (f.length > SUBTITLE_MAX_BYTES) continue;
      const inside = f.path.split(sep).slice(1).join('/') || f.path;
      found.push({
        name: basename(f.path),
        bytes: await readFile(join(root, f.path)),
        ref: `file:${f.path.split(sep).join('/')}`.slice(0, 300),
        release: inside.slice(0, 200),
        tagLanguage: null,
      });
    }
    // Tracks inside the film: one ffmpeg pass writes them all out.
    const tracks = textTracks(probe);
    if (tracks.length) {
      await mkdir(work, { recursive: true });
      const out = tracks.map((t) =>
        join(work, `track-${t.index}.${t.codec === 'ass' || t.codec === 'ssa' ? 'ass' : 'srt'}`),
      );
      const args = ['-nostdin', '-v', 'error', '-y', '-i', src];
      tracks.forEach((t, i) => {
        args.push('-map', `0:${t.index}`, '-c:s', out[i]?.endsWith('.ass') ? 'ass' : 'srt', out[i] ?? '');
      });
      const res = await run('ffmpeg', args, { nice: true }).done;
      if (res.code !== 0)
        log.warn({ media: row.id, stderr: res.stderr.slice(0, 300) }, 'could not read subtitle tracks');
      for (const [i, t] of tracks.entries()) {
        const file = out[i];
        if (!file) continue;
        const bytes = await readFile(file).catch(() => null);
        if (!bytes?.length) continue;
        const label = [t.language, t.title].filter(Boolean).join(' · ');
        found.push({
          name: basename(file),
          bytes,
          ref: `track:${t.index}`,
          release: `${film} #${t.index}${label ? ` (${label})` : ''}`.slice(0, 200),
          tagLanguage: t.language ? (TAG_LANGUAGE[t.language.toLowerCase()] ?? null) : null,
        });
      }
    }
    let added = 0;
    for (const f of found) {
      const id = await insertBundled(d, row.torrent_id, f, convert);
      if (id) {
        added++;
        await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'subtitle', id })]);
      }
    }
    if (added) {
      await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
      log.info({ media: row.id, added }, 'subtitles that came with the download were added');
    }
    return added;
  } finally {
    await removeWorkDir(config.dataDir, work);
  }
}

/** One subtitle, as POST /api/candidates/:id/add writes it; null when unreadable or already there. */
async function insertBundled(d: JobDeps, torrentId: string, f: Found, convert: boolean): Promise<string | null> {
  const { pool, config } = d;
  const parsed = parseSubtitleFile(f.name, f.bytes);
  if (!parsed?.cues.length) return null;
  const original: Cue[] = parsed.cues;
  const language = parsed.language === 'und' && f.tagLanguage ? f.tagLanguage : parsed.language;
  const toHant = convert && language === 'zh-Hans';
  const cues = toHant ? cuesToTraditional(original) : original;
  const cuesJson = JSON.stringify(cues);
  const sha = createHash('sha256').update(cuesJson).digest('hex');
  if (await one(pool, 'select 1 from subtitles where torrent_id = $1 and sha256 = $2', [torrentId, sha])) return null;
  const ext = (extname(f.name).slice(1).toLowerCase() || 'srt').replace(/[^a-z]/g, '');
  const format = parsed.format;
  const doc: SyncDoc = { ...SyncCore.identityDoc(), checkpoints: SyncCore.pickCheckpoints(cues, CHECKPOINT_COUNT) };
  const id = randomUUID();
  const work = join(config.dataDir, 'tmp', 'work', `add-${id}`);
  let placed = false;
  try {
    await mkdir(work, { recursive: true });
    await writeFile(join(work, `original.${ext}`), f.bytes);
    await writeFile(join(work, 'cues.json'), cuesJson);
    if (toHant) await writeFile(join(work, 'cues.original.json'), JSON.stringify(original));
    let bytes = 0;
    for (const name of await readdir(work)) bytes += (await stat(join(work, name))).size;
    await mkdir(join(config.dataDir, 'subtitles'), { recursive: true });
    await rename(work, subtitleDir(config.dataDir, id));
    placed = true;
    const ins = await pool.query(
      `insert into subtitles (id, torrent_id, provider, provider_ref, release_name, language, format, original_encoding, converted_s2t,
                              cue_count, rel_dir, bytes, sha256, doc)
       select $1, t.id, 'bundled', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
         from torrents t where t.id = $2 and t.want <> 'remove'`,
      [
        id,
        torrentId,
        f.ref,
        f.release,
        toHant ? 'zh-Hant' : language,
        format,
        parsed.encoding,
        toHant,
        cues.length,
        subtitleRel(id),
        bytes,
        sha,
        doc,
      ],
    );
    if (!ins.rowCount) {
      await removeOwnSubtitleOutput(config.dataDir, 'subtitle', id);
      return null;
    }
    return id;
  } catch (err) {
    // Our own folder, written for a row that did not get in (a duplicate added meanwhile).
    if (placed) await removeOwnSubtitleOutput(config.dataDir, 'subtitle', id);
    if (pgCode(err) === UNIQUE_VIOLATION) return null;
    throw err;
  } finally {
    await removeWorkDir(config.dataDir, work);
  }
}
