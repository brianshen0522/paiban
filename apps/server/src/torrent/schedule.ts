/**
 * Which queued downloads start now (docs/06-torrent-worker.md, "排程"). Candidates come oldest
 * first. A download whose requester is gone, or no longer holds it, only counts toward the
 * site-wide limit.
 */
export type QueuedCandidate = { id: string; requestedBy: string | null; requesterHolds: boolean };

export function pickToStart(
  candidates: QueuedCandidate[],
  activeByUser: Map<string, number>,
  activeTotal: number,
  limits: { maxActive: number; maxPerUser: number },
): string[] {
  const started: string[] = [];
  const perUser = new Map(activeByUser);
  let total = activeTotal;
  for (const c of candidates) {
    if (total >= limits.maxActive) break;
    const owner = c.requestedBy && c.requesterHolds ? c.requestedBy : null;
    if (owner && (perUser.get(owner) ?? 0) >= limits.maxPerUser) continue;
    started.push(c.id);
    total++;
    if (owner) perUser.set(owner, (perUser.get(owner) ?? 0) + 1);
  }
  return started;
}

export const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm'];

/** The largest video file of a torrent, or null when there is none. */
export function mainVideo(files: { path: string; length: number }[]): { path: string; length: number } | null {
  let best: { path: string; length: number } | null = null;
  for (const f of files) {
    const lower = f.path.toLowerCase();
    if (!VIDEO_EXTENSIONS.some((e) => lower.endsWith(e))) continue;
    if (!best || f.length > best.length) best = f;
  }
  return best;
}

/** Whether every file path stays inside the download folder (torrent names are untrusted). */
export function pathsAreSafe(
  root: string,
  files: { path: string }[],
  resolve: (...p: string[]) => string,
  sep: string,
): boolean {
  const base = resolve(root) + sep;
  return files.every((f) => resolve(root, f.path).startsWith(base));
}

export type Stall = 'METADATA_TIMEOUT' | 'STALLED' | null;

export function stalled(
  now: number,
  startedAt: number,
  lastProgressAt: number,
  hasMetadata: boolean,
  stallMinutes: number,
): Stall {
  if (!hasMetadata) return now - startedAt > 5 * 60_000 ? 'METADATA_TIMEOUT' : null;
  return now - lastProgressAt > stallMinutes * 60_000 ? 'STALLED' : null;
}
