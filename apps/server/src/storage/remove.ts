import { rm, unlink } from 'node:fs/promises';
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
