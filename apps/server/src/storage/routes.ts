import type { StorageItem, Usage } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { storageFindings } from '../admin/system-routes.js';
import { audit } from '../audit.js';
import { many, tx } from '../db/pool.js';
import { publishUsage } from '../events/publish.js';
import { filmExportTotals } from '../exports/film-exports.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin, requireUser } from '../http/guards.js';
import { diskInfo, readUsage } from './usage.js';

type ItemRow = {
  torrent_id: string;
  state: string;
  title: string;
  quality: string;
  source_type: string;
  video_codec: string;
  bytes: number;
  media_id: string | null;
  preview_bytes: number;
  proxy_res: '480p' | '720p' | null;
  holders: { id: string; displayName: string }[];
  last_used_at: Date | null;
};

/** Films as storage items: one per torrent, plus one for its preview assets when there are any. */
async function storageItems(deps: Deps, userId: string | null): Promise<StorageItem[]> {
  const rows = await many<ItemRow>(
    deps.pool,
    `select t.id as torrent_id, t.state, m.title, t.quality, t.source_type, t.video_codec, t.last_used_at,
            case when t.state = 'completed' then t.disk_bytes + coalesce(mf.analysis_bytes, 0)
                 when t.state = 'failed' then t.disk_bytes
                 else greatest(t.size_bytes, coalesce(t.length_bytes, 0)) + t.preview_reserve_bytes end as bytes,
            mf.id as media_id, coalesce(mf.audio_bytes + mf.proxy_bytes + mf.reserve_bytes, 0) as preview_bytes, mf.proxy_res,
            coalesce((select json_agg(json_build_object('id', u.id, 'displayName', u.display_name) order by h.added_at)
                        from torrent_holders h join users u on u.id = h.user_id where h.torrent_id = t.id), '[]'::json) as holders
       from torrents t join movies m on m.id = t.movie_id left join media_files mf on mf.torrent_id = t.id
      where t.want <> 'remove'
        and ($1::uuid is null or exists (select 1 from torrent_holders h where h.torrent_id = t.id and h.user_id = $1))`,
    [userId],
  );
  const items: StorageItem[] = [];
  const fe = await filmExportTotals(
    deps.pool,
    rows.map((r) => r.torrent_id),
  );
  for (const r of rows) {
    const version = [
      r.quality,
      r.source_type === 'bluray' ? 'BluRay' : r.source_type === 'web' ? 'WEB' : r.source_type,
      r.video_codec,
    ]
      .filter(Boolean)
      .join(' ');
    const base = {
      torrentId: r.torrent_id,
      movieTitle: r.title,
      version,
      fileName: null,
      holders: r.holders,
      lastUsedAt: r.last_used_at?.toISOString() ?? null,
    };
    const kind = r.state === 'completed' ? 'movie' : r.state === 'failed' ? 'partial' : 'reserved';
    const filmExports = fe.get(r.torrent_id) ?? { count: 0, bytes: 0 };
    items.push({ ...base, kind, id: r.torrent_id, previewResolution: null, bytes: r.bytes, filmExports });
    if (r.media_id && r.preview_bytes > 0)
      items.push({
        ...base,
        kind: 'preview',
        id: r.media_id,
        previewResolution: r.proxy_res,
        bytes: r.preview_bytes,
        filmExports: null,
      });
  }
  // The administrator's list also has every export (the member's own come from GET /api/exports).
  if (userId === null) {
    const exps = await many<{
      id: string;
      torrent_id: string | null;
      movie_title: string;
      file_name: string;
      bytes: number;
      by_id: string | null;
      by_name: string | null;
      created_at: Date;
    }>(
      deps.pool,
      `select e.id, e.torrent_id, e.movie_title, e.file_name, e.created_at,
              case when e.state = 'done' then e.size_bytes else e.reserved_bytes end as bytes, u.id as by_id, u.display_name as by_name
         from exports e left join users u on u.id = e.created_by where e.state <> 'failed' or e.size_bytes > 0`,
    );
    for (const e of exps)
      items.push({
        kind: 'export',
        id: e.id,
        torrentId: e.torrent_id,
        movieTitle: e.movie_title,
        version: null,
        previewResolution: null,
        fileName: e.file_name,
        bytes: e.bytes,
        holders: e.by_id ? [{ id: e.by_id, displayName: e.by_name ?? '' }] : [],
        lastUsedAt: e.created_at.toISOString(),
        filmExports: null,
      });
  }
  return items.sort((a, b) => b.bytes - a.bytes);
}

export function storageRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  app.get('/api/storage', async (req) => {
    const user = requireUser(req);
    return { usage: await readUsage(pool), items: await storageItems(deps, user.id) };
  });

  app.get('/api/admin/storage', async (req) => {
    requireAdmin(req);
    return {
      usage: await readUsage(pool),
      items: await storageItems(deps, null),
      disk: await diskInfo(pool, deps.disk, config.storageReserveBytes),
      ...(await storageFindings(deps)),
    };
  });

  /** docs/10-storage.md, "上限的驗證". Lower than the current use is allowed: nothing is deleted. */
  app.put('/api/admin/storage/limit', async (req): Promise<Usage> => {
    const user = requireAdmin(req);
    const { limitBytes } = parse(z.object({ limitBytes: z.number().int() }), req.body);
    const gb = 1024 ** 3;
    if (limitBytes < gb || limitBytes % gb !== 0)
      throw new ApiError('SETTING_INVALID', 'whole gigabytes, at least 1', { fields: { limitBytes: 'NOT_WHOLE_GB' } });
    const disk = await diskInfo(pool, deps.disk, config.storageReserveBytes);
    if (limitBytes > disk.maxLimitBytes)
      throw new ApiError('SETTING_INVALID', 'more than the disk can give', { fields: { limitBytes: 'ABOVE_DISK' } });
    const before = await readUsage(pool);
    await tx(pool, async (c) => {
      await c.query(
        `insert into settings (key, value, updated_by) values ('storage.limitBytes', $1::jsonb, $2)
         on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
        [JSON.stringify(limitBytes), user.id],
      );
      await audit(c, user, 'admin.storage.limit', { fromBytes: before.limitBytes, toBytes: limitBytes }, req.ip);
    });
    await publishUsage(pool, deps.events);
    return readUsage(pool);
  });
}
