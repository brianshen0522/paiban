import type { FilmExports as FilmExportsTotal } from '@paiban/shared';
import { audit } from '../audit.js';
import { type Client, many, type Queryable } from '../db/pool.js';
import { publishNotification } from '../events/publish.js';
import type { Deps } from '../http/context.js';
import { removeExportFiles } from '../storage/remove.js';

/**
 * Deleting a film deletes its exports too (Brian, 2026-10-06; docs/10-storage.md, "刪除"): the
 * last holder removing it, or an administrator forcing it. Runs inside the transaction that marks
 * the film `want = 'remove'`, the same way deleting one export does: waiting or finished ones go
 * at once, one being written is cancelled and the media service removes it once it stops.
 * Creators other than the person who pressed it are told.
 */
export type FilmExports = { removed: string[]; running: string[]; freedBytes: number; notes: number[] };

export async function dropFilmExports(
  c: Client,
  torrentId: string,
  actor: { id: string; displayName: string },
  ip: string | null,
): Promise<FilmExports> {
  const rows = await many<{
    id: string;
    state: string;
    size_bytes: number;
    reserved_bytes: number;
    created_by: string | null;
    movie_title: string;
    file_name: string;
  }>(
    c,
    `select id, state, size_bytes, reserved_bytes, created_by, movie_title, file_name
       from exports where torrent_id = $1 and not cancel_requested for update`,
    [torrentId],
  );
  const out: FilmExports = { removed: [], running: [], freedBytes: 0, notes: [] };
  for (const e of rows) {
    if (e.created_by && e.created_by !== actor.id) {
      const n = await c.query<{ id: number }>(
        `insert into notifications (user_id, kind, data, link)
         values ($1, 'item.deleted', jsonb_build_object('actor', $2::text, 'itemKind', 'export', 'fileName', $3::text, 'movieTitle', $4::text), null) returning id`,
        [e.created_by, actor.displayName, e.file_name, e.movie_title],
      );
      for (const r of n.rows) out.notes.push(r.id);
    }
    if (e.state === 'running') {
      await c.query('update exports set cancel_requested = true where id = $1', [e.id]);
      out.running.push(e.id);
    } else {
      await c.query('delete from exports where id = $1', [e.id]);
      await c.query(
        `update tasks set state = 'cancelled', finished_at = now() where kind = 'export' and input->>'exportId' = $1 and state in ('queued', 'running')`,
        [e.id],
      );
      out.removed.push(e.id);
    }
    out.freedBytes += e.state === 'done' ? e.size_bytes : e.reserved_bytes;
    await audit(c, actor, 'export.delete', { fileName: e.file_name, withFilm: 1 }, ip);
  }
  return out;
}

/** After the transaction: the files of the ones removed at once, and word to everyone. */
export async function finishFilmExports(deps: Deps, x: FilmExports): Promise<void> {
  for (const id of x.removed) await removeExportFiles(deps.config.dataDir, id, deps.log);
  if (x.running.length) await deps.pool.query(`select pg_notify('paiban_media', '{}')`);
  for (const id of [...x.removed, ...x.running]) deps.events.toAll({ type: 'export.removed', id });
  for (const n of x.notes) await publishNotification(deps.pool, deps.events, n);
}

/** What deleting each film would take with it: its exports, counted the way the delete frees them. */
export async function filmExportTotals(q: Queryable, torrentIds: string[]): Promise<Map<string, FilmExportsTotal>> {
  const rows = await many<{ torrent_id: string; count: number; bytes: number }>(
    q,
    `select torrent_id, count(*)::int as count,
            coalesce(sum(case when state = 'done' then size_bytes when state in ('queued', 'running') then reserved_bytes else 0 end), 0)::bigint as bytes
       from exports where torrent_id = any($1::uuid[]) and not cancel_requested group by torrent_id`,
    [torrentIds],
  );
  return new Map(rows.map((r) => [r.torrent_id, { count: r.count, bytes: Number(r.bytes) }]));
}
