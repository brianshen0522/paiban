import type { LibraryItem, SubtitleLang, Workspace } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { filmExportTotals } from '../exports/film-exports.js';
import { exportsForTorrent } from '../exports/view.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { readUsage } from '../storage/usage.js';
import { subtitleRows, toSubtitle } from '../subtitles/store.js';
import { holderTorrent } from '../torrents/routes.js';
import { selectTorrents, type TorrentRow, toTorrent } from '../torrents/view.js';

/** One library card: counts of subtitles and exports and the step its main button leads to. */
async function libraryItems(q: Queryable, rows: TorrentRow[], viewerId: string): Promise<LibraryItem[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const subs = await many<{ torrent_id: string; total: number; confirmed: number; langs: SubtitleLang[] }>(
    q,
    `select torrent_id, count(*)::int as total, count(*) filter (where status = 'confirmed')::int as confirmed,
            coalesce(array_agg(distinct language order by language) filter (where status = 'confirmed'), '{}') as langs
       from subtitles where torrent_id = any($1::uuid[]) group by torrent_id`,
    [ids],
  );
  const exps = await many<{ torrent_id: string; n: number }>(
    q,
    `select torrent_id, count(*)::int as n from exports where torrent_id = any($1::uuid[]) and state = 'done' group by torrent_id`,
    [ids],
  );
  const fe = await filmExportTotals(q, ids);
  const s = new Map(subs.map((x) => [x.torrent_id, x]));
  const e = new Map(exps.map((x) => [x.torrent_id, x.n]));
  return rows.map((r) => {
    const total = s.get(r.id)?.total ?? 0;
    const confirmed = s.get(r.id)?.confirmed ?? 0;
    const exports = e.get(r.id) ?? 0;
    const next: LibraryItem['next'] =
      exports > 0 ? 'exported' : confirmed > 0 ? 'export' : total > 0 ? 'sync' : 'subtitles';
    return {
      torrent: toTorrent(r, viewerId),
      subtitles: { total, confirmed, draft: total - confirmed },
      exports,
      filmExports: fe.get(r.id) ?? { count: 0, bytes: 0 },
      next,
      confirmedLanguages: s.get(r.id)?.langs ?? [],
    };
  });
}

const ListQuery = z.object({ scope: z.enum(['mine', 'all']).default('mine') });

export function libraryRoutes(app: FastifyInstance, deps: Deps): void {
  /**
   * Finished films the caller holds, analysing ones included (docs/11-pages.md, "片庫"); with
   * `scope=all`, every finished film on the site, for everyone (Brian, 2026-10-09).
   */
  app.get('/api/library', async (req): Promise<LibraryItem[]> => {
    const user = requireUser(req);
    const { scope } = parse(ListQuery, req.query);
    const rows =
      scope === 'all'
        ? await selectTorrents(deps.pool, `t.state = 'completed'`, [])
        : await selectTorrents(
            deps.pool,
            `t.state = 'completed' and exists (select 1 from torrent_holders h where h.torrent_id = t.id and h.user_id = $1)`,
            [user.id],
          );
    rows.sort((a, b) => (b.completed_at?.getTime() ?? 0) - (a.completed_at?.getTime() ?? 0));
    return libraryItems(deps.pool, rows, user.id);
  });

  /** Everything the workspace needs at once (docs/04-api.md, "片庫"). It never starts the analysis. */
  app.get('/api/library/:torrentId', async (req): Promise<Workspace> => {
    const user = requireUser(req);
    const { torrentId } = parse(z.object({ torrentId: z.uuid() }), req.params);
    const row = await holderTorrent(deps, user, torrentId);
    if (row.state !== 'completed') throw new ApiError('MEDIA_NOT_READY', 'the download has not finished');
    const [item] = await libraryItems(deps.pool, [row], user.id);
    const media = await one<{ size_bytes: number }>(
      deps.pool,
      'select size_bytes from media_files where torrent_id = $1',
      [torrentId],
    );
    // A record of use, not anyone's data (docs/04-api.md: one of the two things a GET may write), at most once an hour.
    await deps.pool.query(
      `update torrents set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 hour')`,
      [torrentId],
    );
    return {
      item: item as LibraryItem,
      subtitles: (await subtitleRows(deps.pool, torrentId)).map(toSubtitle),
      exports: await exportsForTorrent(deps, torrentId, user.id),
      usage: await readUsage(deps.pool),
      exportNeedBytes: Math.ceil((media?.size_bytes ?? 0) * 1.01) + 1024 * 1024,
    };
  });
}
