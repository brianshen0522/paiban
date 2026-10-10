import { readdir, rm, rmdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { POSTER_REGIONS } from '@paiban/shared';
import type { Logger } from 'pino';
import type { Engine } from '../torrent/engine.js';

/**
 * THE deletion module (docs/10-storage.md, "刪除"; AGENTS.md rule 1). Nothing else in the program
 * removes anything under /data, WebTorrent's destroyStore included. Every function here is the
 * execution of something a person pressed, or one of the listed scratch clean-ups; none of them
 * takes or computes an age, and nothing calls them because time passed.
 */

/** Paths are built from ids the database gave us, never from a request. */
function under(dataDir: string, ...parts: string[]): string {
  for (const p of parts)
    if (!p || p.includes('/') || p.includes('\\') || p === '.' || p === '..') throw new Error(`unsafe path part ${p}`);
  return join(dataDir, ...parts);
}

export type RemovedDownload = { infoHash: string; mediaIds: string[]; subtitleIds: string[]; candidateIds: string[] };

/**
 * A download whose `want` is 'remove': the last holder left or an administrator force-deleted it
 * (docs/03-data-model.md, "刪除一個下載時發生的事", steps 1 and 3). Safe to run again after a crash:
 * removing what is already gone is not an error.
 */
export async function removeDownloadFiles(
  dataDir: string,
  engine: Engine,
  d: RemovedDownload,
  log: Logger,
): Promise<void> {
  await engine.removeAndDeleteFiles(d.infoHash);
  const dirs = [
    under(dataDir, 'torrents', d.infoHash),
    ...d.mediaIds.map((id) => under(dataDir, 'media', id)),
    ...d.subtitleIds.map((id) => under(dataDir, 'subtitles', id)),
    ...d.candidateIds.map((id) => under(dataDir, 'subtitles', 'candidates', id)),
    // An upload or a download still waiting to be processed: its staging folder goes with it.
    ...d.candidateIds.map((id) => under(dataDir, 'tmp', 'uploads', id)),
  ];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  log.info({ infoHash: d.infoHash, folders: dirs.length }, 'download removed (requested by a person)');
}

/**
 * The poster copy of a film whose last download was removed (step 5): `posters/<yts id>.jpg`, or
 * `posters/tmdb-<id>.<ext>` for a film added by hand. Anything else in `movies.poster_path` is left alone.
 */
export async function removePoster(dataDir: string, posterPath: string): Promise<void> {
  const stem = /^posters\/((?:tmdb-)?\d{1,12})\.(?:jpg|png|webp)$/.exec(posterPath)?.[1];
  if (!stem) return;
  // The copy kept when the film was added, and the per-country copies kept since (Brian, 2026-10-10).
  const names = ['', ...POSTER_REGIONS.map((r) => `-${r}`)].flatMap((suffix) =>
    ['jpg', 'png', 'webp'].map((ext) => `${stem}${suffix}.${ext}`),
  );
  for (const name of names) await unlink(under(dataDir, 'posters', name)).catch(() => undefined);
}

/**
 * An administrator deleted a film's preview assets (docs/10-storage.md, "刪除": 管理員刪除預覽檔).
 * Only the preview video and audio go; the film and its analysis stay.
 */
export async function removePreviewFiles(dataDir: string, mediaId: string, log: Logger): Promise<void> {
  for (const f of ['audio.m4a', 'proxy.mp4']) await rm(under(dataDir, 'media', mediaId, f), { force: true });
  log.info({ mediaId }, 'preview files removed (requested by an administrator)');
}

/**
 * An export deleted by its creator or an administrator, or with its film when the film is deleted
 * (the last holder removing it, or an administrator forcing it): the export's folder (the MKV, or the
 * subtitle tracks of one still waiting). Also the `api`'s own just-written tracks when the
 * request that wrote them did not get its row in.
 */
export async function removeExportFiles(dataDir: string, exportId: string, log: Logger): Promise<void> {
  await rm(under(dataDir, 'exports', exportId), { recursive: true, force: true });
  log.info({ exportId }, 'export removed (requested by a person)');
}

/**
 * A folder the last recalculation found with no row (an orphan), deleted by an administrator.
 * The caller checks again, just before, that it still has no row.
 */
export async function removeOrphanFolder(
  dataDir: string,
  root: 'torrents' | 'media' | 'subtitles' | 'candidates' | 'exports',
  name: string,
  log: Logger,
): Promise<void> {
  const path = root === 'candidates' ? under(dataDir, 'subtitles', 'candidates', name) : under(dataDir, root, name);
  await rm(path, { recursive: true, force: true });
  log.info({ root, name }, 'orphan folder removed (requested by an administrator)');
}

/**
 * A holder removed a candidate subtitle (docs/04-api.md, `DELETE /api/candidates/:id`): what was
 * fetched for it, and the upload or download still waiting to be processed.
 */
export async function removeCandidateFiles(dataDir: string, candidateId: string, log: Logger): Promise<void> {
  await rm(under(dataDir, 'subtitles', 'candidates', candidateId), { recursive: true, force: true });
  await rm(under(dataDir, 'tmp', 'uploads', candidateId), { recursive: true, force: true });
  log.info({ candidateId }, 'candidate removed (requested by a person)');
}

/** A holder removed a subtitle and its sync result (`DELETE /api/subtitles/:id`). */
export async function removeSubtitleFiles(dataDir: string, subtitleId: string, log: Logger): Promise<void> {
  await rm(under(dataDir, 'subtitles', subtitleId), { recursive: true, force: true });
  log.info({ subtitleId }, 'subtitle removed (requested by a person)');
}

/* ---------------------------------------------------------------- scratch (docs/10-storage.md, "哪些清理不算自動刪除") */

/**
 * The media service at start-up: the work folders of jobs that did not finish, and half-written
 * `*.part` files under /data/media and /data/exports (never under /data/torrents, which belongs to
 * WebTorrent). These are the program's own drafts, not anybody's files.
 */
export async function cleanScratchOnStart(dataDir: string, log: Logger): Promise<number> {
  await rm(join(dataDir, 'tmp', 'work'), { recursive: true, force: true });
  let parts = 0;
  for (const root of ['media', 'exports']) {
    const base = join(dataDir, root);
    let dirs: string[] = [];
    try {
      dirs = await readdir(base);
    } catch {
      continue;
    }
    for (const d of dirs) {
      let files: string[] = [];
      try {
        files = await readdir(join(base, d));
      } catch {
        continue;
      }
      for (const f of files)
        if (f.endsWith('.part')) {
          await rm(join(base, d, f), { force: true });
          parts++;
        }
    }
  }
  log.info({ parts }, 'scratch cleaned at start-up');
  return parts;
}

/** A job's own work folder under /data/tmp/work, when the job ends either way. */
export async function removeWorkDir(dataDir: string, jobDir: string): Promise<void> {
  if (!jobDir.startsWith(join(dataDir, 'tmp', 'work'))) throw new Error('not a work folder');
  await rm(jobDir, { recursive: true, force: true });
}

/**
 * A job's own output that it just wrote, when its final conditional update found the row gone,
 * cancelled or being deleted (docs/08-media-pipeline.md, "工作的共通規矩"). Only names under
 * /data/media/<id> that a media job writes.
 */
export async function removeOwnMediaOutput(dataDir: string, mediaId: string, files: string[]): Promise<void> {
  const allowed = new Set([
    'probe.json',
    'peaks.bin',
    'ref.npz',
    'speech.json',
    'audio.m4a',
    'proxy.mp4',
    'audio.m4a.part',
    'proxy.mp4.part',
  ]);
  for (const f of files) {
    if (!allowed.has(f)) throw new Error(`not a media output: ${f}`);
    await rm(under(dataDir, 'media', mediaId, f), { force: true });
  }
}

/** Removes an export's folder if nothing is left in it (an empty folder is nobody's file). */
async function dropEmptyExportDir(dataDir: string, exportId: string): Promise<void> {
  await rmdir(under(dataDir, 'exports', exportId)).catch(() => undefined);
}

/**
 * The subtitle tracks an export wrote for ffmpeg (`/data/exports/<id>/tracks/`), once the export
 * has its final outcome: done, failed twice, cancelled, or its film removed (docs/10-storage.md,
 * "哪些清理不算自動刪除"). The folder goes too when that leaves it empty.
 */
export async function removeExportTracks(dataDir: string, exportId: string): Promise<void> {
  await rm(under(dataDir, 'exports', exportId, 'tracks'), { recursive: true, force: true });
  await dropEmptyExportDir(dataDir, exportId);
}

/**
 * The mux job's own output: its `.part`, or the finished MKV when the final conditional update
 * found the row cancelled or its film being removed (docs/08-media-pipeline.md, "工作的共通規矩").
 */
export async function removeOwnExportOutput(dataDir: string, exportId: string, fileName: string): Promise<void> {
  if (!/\.mkv(\.part)?$/i.test(fileName)) throw new Error(`not an export output: ${fileName}`);
  await rm(under(dataDir, 'exports', exportId, fileName), { force: true });
  await dropEmptyExportDir(dataDir, exportId);
}

/**
 * A subtitle or candidate folder that a job (or the api's "add") just moved into place, when its
 * final conditional write found the film being removed, the row gone, or the same subtitle added
 * by someone else meanwhile (docs/03-data-model.md, "刪除一個下載時發生的事"; docs/07, "加入" step 6).
 */
export async function removeOwnSubtitleOutput(
  dataDir: string,
  kind: 'subtitle' | 'candidate',
  id: string,
): Promise<void> {
  const dir = kind === 'subtitle' ? under(dataDir, 'subtitles', id) : under(dataDir, 'subtitles', 'candidates', id);
  await rm(dir, { recursive: true, force: true });
}

/**
 * An upload or download waiting under /data/tmp/uploads, when the job that uses it ends, or when
 * the request that wrote it found nothing to do with it (the same file again). `name` is the
 * candidate id or the request's own temporary name.
 */
export async function removeStaging(dataDir: string, name: string): Promise<void> {
  await rm(under(dataDir, 'tmp', 'uploads', name), { recursive: true, force: true });
}
