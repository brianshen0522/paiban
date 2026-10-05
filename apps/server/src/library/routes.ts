import type { LibraryItem } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { many } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { requireUser } from '../http/guards.js';
import { selectTorrents, toTorrent } from '../torrents/view.js';

export function libraryRoutes(app: FastifyInstance, deps: Deps): void {
  /** Finished films the caller holds, analysing ones included (docs/11-pages.md, "片庫"). */
  app.get('/api/library', async (req): Promise<LibraryItem[]> => {
    const user = requireUser(req);
    const rows = await selectTorrents(
      deps.pool,
      `t.state = 'completed' and exists (select 1 from torrent_holders h where h.torrent_id = t.id and h.user_id = $1)`,
      [user.id],
    );
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const subs = await many<{ torrent_id: string; total: number; confirmed: number }>(
      deps.pool,
      `select torrent_id, count(*)::int as total, count(*) filter (where status = 'confirmed')::int as confirmed
         from subtitles where torrent_id = any($1::uuid[]) group by torrent_id`,
      [ids],
    );
    const exps = await many<{ torrent_id: string; n: number }>(
      deps.pool,
      `select torrent_id, count(*)::int as n from exports where torrent_id = any($1::uuid[]) and state = 'done' group by torrent_id`,
      [ids],
    );
    const s = new Map(subs.map((x) => [x.torrent_id, x]));
    const e = new Map(exps.map((x) => [x.torrent_id, x.n]));
    return rows
      .sort((a, b) => (b.completed_at?.getTime() ?? 0) - (a.completed_at?.getTime() ?? 0))
      .map((r) => {
        const total = s.get(r.id)?.total ?? 0;
        const confirmed = s.get(r.id)?.confirmed ?? 0;
        const exports = e.get(r.id) ?? 0;
        const next: LibraryItem['next'] =
          exports > 0 ? 'exported' : confirmed > 0 ? 'export' : total > 0 ? 'sync' : 'subtitles';
        return {
          torrent: toTorrent(r, user.id),
          subtitles: { total, confirmed, draft: total - confirmed },
          exports,
          next,
        };
      });
  });
}
