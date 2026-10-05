import { readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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
  ];
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  log.info({ infoHash: d.infoHash, folders: dirs.length }, 'download removed (requested by a person)');
}

/** The poster copy of a film whose last download was removed (step 5). */
export async function removePoster(dataDir: string, ytsId: number): Promise<void> {
  await unlink(under(dataDir, 'posters', `${ytsId}.jpg`)).catch(() => undefined);
}

/**
 * An administrator deleted a film's preview assets (docs/10-storage.md, "刪除": 管理員刪除預覽檔).
 * Only the preview video and audio go; the film and its analysis stay.
 */
export async function removePreviewFiles(dataDir: string, mediaId: string, log: Logger): Promise<void> {
  for (const f of ['audio.m4a', 'proxy.mp4']) await rm(under(dataDir, 'media', mediaId, f), { force: true });
  log.info({ mediaId }, 'preview files removed (requested by an administrator)');
}

/** An export file deleted by its creator or an administrator: the export's folder. */
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
