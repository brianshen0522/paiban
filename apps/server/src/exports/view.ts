import type { DetectedLang, Export, ExportErrorCode } from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { many } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';

/** One entry of `exports.tracks` (db/schema.sql): what was muxed, kept even after the subtitle changes. */
export type TrackRecord = {
  subtitleId: string;
  rev: number;
  language: DetectedLang;
  title: string;
  isDefault: boolean;
};

/**
 * Matroska language and track title for a subtitle language (docs/08-media-pipeline.md, "語言標籤").
 * ffmpeg writes three-letter codes only, so Traditional and Simplified Chinese differ by title.
 * These titles are fixed strings written into the file, not interface copy.
 */
export function trackTag(language: string): { language: string; title: string } {
  if (language === 'zh-Hant' || language === 'zh') return { language: 'chi', title: '繁體中文' };
  if (language === 'zh-Hans') return { language: 'chi', title: '简体中文' };
  if (language === 'en') return { language: 'eng', title: 'English' };
  return { language: 'und', title: language };
}

export type ExportRow = {
  id: string;
  torrent_id: string | null;
  movie_title: string;
  version_label: string;
  file_name: string;
  tracks: TrackRecord[];
  state: Export['state'];
  progress: number;
  reserved_bytes: number;
  size_bytes: number;
  rel_path: string | null;
  error_code: ExportErrorCode | null;
  cancel_requested: boolean;
  created_by: string | null;
  by_name: string | null;
  created_at: Date;
  completed_at: Date | null;
};

const EXPORT_SELECT = `select e.id, e.torrent_id, e.movie_title, e.version_label, e.file_name, e.tracks, e.state, e.progress,
       e.reserved_bytes, e.size_bytes, e.rel_path, e.error_code, e.cancel_requested, e.created_by, u.display_name as by_name,
       e.created_at, e.completed_at
  from exports e left join users u on u.id = e.created_by`;

/** Exports matching `where` (uses $1…), newest first. A cancelled one waiting for media to stop is not listed. */
export async function selectExports(q: Queryable, where: string, params: unknown[]): Promise<ExportRow[]> {
  return many<ExportRow>(
    q,
    `${EXPORT_SELECT} where not e.cancel_requested and (${where}) order by e.created_at desc`,
    params,
  );
}

/** `canDelete` depends on who is looking: the creator or an administrator. */
export function toExport(r: ExportRow, viewer: { id: string; role: 'admin' | 'member' }): Export {
  return {
    id: r.id,
    torrentId: r.torrent_id,
    movieTitle: r.movie_title,
    versionLabel: r.version_label,
    fileName: r.file_name,
    tracks: r.tracks.map((t) => ({ language: t.language, title: t.title, isDefault: t.isDefault })),
    state: r.state,
    progress: r.state === 'done' ? 1 : r.progress,
    sizeBytes: r.state === 'done' ? r.size_bytes : 0,
    errorCode: r.error_code,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.by_name ?? '' } : null,
    createdAt: r.created_at.toISOString(),
    completedAt: r.completed_at?.toISOString() ?? null,
    downloadUrl: r.state === 'done' ? `/api/exports/${r.id}/file` : null,
    canDelete: viewer.role === 'admin' || viewer.id === r.created_by,
  };
}

async function roleOf(q: Queryable, ids: string[]): Promise<Map<string, 'admin' | 'member'>> {
  const rows = await many<{ id: string; role: 'admin' | 'member' }>(
    q,
    'select id, role from users where id = any($1::uuid[])',
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r.role]));
}

/** The exports of one film, for its workspace (`Workspace.exports`), as `viewerId` sees them. */
export async function exportsForTorrent(
  deps: { pool: Queryable },
  torrentId: string,
  viewerId: string,
): Promise<Export[]> {
  const role = (await roleOf(deps.pool, [viewerId])).get(viewerId) ?? 'member';
  const rows = await selectExports(deps.pool, 'e.torrent_id = $1', [torrentId]);
  return rows.map((r) => toExport(r, { id: viewerId, role }));
}

/**
 * Pushes an export to the people allowed to see it (docs/04-api.md, "即時更新"): the holders of
 * its film and its creator, each with their own `canDelete`. A row that is gone (or cancelled and
 * waiting for media to stop) becomes `export.removed`, which goes to everyone and says only the id.
 */
export async function publishExport(q: Queryable, hub: EventHub, id: string): Promise<void> {
  const [row] = await selectExports(q, 'e.id = $1', [id]);
  if (!row) {
    hub.toAll({ type: 'export.removed', id });
    return;
  }
  const online = hub.connectedUsers();
  if (online.size === 0) return;
  const holders = row.torrent_id
    ? await many<{ user_id: string }>(
        q,
        `select h.user_id from torrent_holders h join torrents t on t.id = h.torrent_id where h.torrent_id = $1 and t.want <> 'remove'`,
        [row.torrent_id],
      )
    : [];
  const people = [...new Set([...holders.map((h) => h.user_id), ...(row.created_by ? [row.created_by] : [])])].filter(
    (u) => online.has(u),
  );
  if (people.length === 0) return;
  const roles = await roleOf(q, people);
  for (const u of people)
    hub.toUser(u, { type: 'export', export: toExport(row, { id: u, role: roles.get(u) ?? 'member' }) });
}
