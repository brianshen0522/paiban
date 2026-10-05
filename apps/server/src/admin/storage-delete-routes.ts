import type { StorageItemKind } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { type Client, one, tx } from '../db/pool.js';
import { publishNotification, publishUsage } from '../events/publish.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin } from '../http/guards.js';
import { removeExportFiles, removeOrphanFolder, removePreviewFiles } from '../storage/remove.js';
import { versionLabel } from '../torrents/view.js';

/**
 * DELETE /api/admin/storage/items/:kind/:id (D23; docs/10-storage.md, "刪除"). An administrator
 * removes anything, whoever holds it. The people affected are told (item.deleted), not the
 * administrator who pressed it. Film files themselves are deleted by the torrent service, which
 * picks up `want = 'remove'`; preview, export and orphan files go through storage/remove.ts here.
 */
const Params = z.object({
  kind: z.enum(['movie', 'reserved', 'partial', 'preview', 'export', 'orphan']),
  id: z.uuid(),
});

const TORRENT_KIND_STATES: Record<'movie' | 'reserved' | 'partial', string[]> = {
  movie: ['completed'],
  reserved: ['queued', 'downloading', 'paused'],
  partial: ['failed'],
};

/** Tells everyone affected except the administrator who did it. Returns the notification ids. */
async function tellHolders(
  c: Client,
  torrentId: string,
  admin: AuthedUser,
  itemKind: StorageItemKind,
  movieTitle: string,
  version: string,
): Promise<number[]> {
  const r = await c.query<{ id: number }>(
    `insert into notifications (user_id, kind, data, link)
     select h.user_id, 'item.deleted', jsonb_build_object('actor', $2::text, 'itemKind', $3::text, 'movieTitle', $4::text, 'version', $5::text), null
       from torrent_holders h where h.torrent_id = $1 and h.user_id <> $6 returning id`,
    [torrentId, admin.displayName, itemKind, movieTitle, version, admin.id],
  );
  return r.rows.map((x) => x.id);
}

export function storageDeleteRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config, log } = deps;

  app.delete('/api/admin/storage/items/:kind/:id', async (req) => {
    const admin = requireAdmin(req);
    const { kind, id } = parse(Params, req.params);
    let freedBytes = 0;
    let notes: number[] = [];
    let removedTorrent: string | null = null;

    if (kind === 'movie' || kind === 'reserved' || kind === 'partial') {
      const out = await tx(pool, async (c) => {
        const t = await one<{
          state: string;
          title: string;
          quality: string;
          source_type: string;
          video_codec: string;
          freed: number;
        }>(
          c,
          `select t.state, m.title, t.quality, t.source_type, t.video_codec,
                  case when t.state = 'completed' then t.disk_bytes + coalesce(mf.analysis_bytes + mf.audio_bytes + mf.proxy_bytes + mf.reserve_bytes, 0)
                       when t.state = 'failed' then t.disk_bytes
                       else greatest(t.size_bytes, coalesce(t.length_bytes, 0)) + t.preview_reserve_bytes end as freed
             from torrents t join movies m on m.id = t.movie_id left join media_files mf on mf.torrent_id = t.id
            where t.id = $1 and t.want <> 'remove' for update of t`,
          [id],
        );
        if (!t) throw new ApiError('NOT_FOUND', 'no such item');
        // The page may be stale: a download finished or failed since. Say so instead of guessing.
        if (!TORRENT_KIND_STATES[kind].includes(t.state))
          throw new ApiError('TORRENT_STATE', `item is ${t.state}, not ${kind}`);
        const version = versionLabel(t);
        const n = await tellHolders(c, id, admin, kind, t.title, version);
        await c.query(`update torrents set want = 'remove' where id = $1`, [id]);
        await audit(c, admin, 'admin.storage.delete', { itemKind: kind, movieTitle: t.title }, req.ip);
        return { freed: t.freed, notes: n };
      });
      freedBytes = out.freed;
      notes = out.notes;
      removedTorrent = id;
    } else if (kind === 'preview') {
      const out = await tx(pool, async (c) => {
        const m = await one<{
          torrent_id: string;
          title: string;
          quality: string;
          source_type: string;
          video_codec: string;
          freed: number;
        }>(
          c,
          `select mf.torrent_id, mv.title, t.quality, t.source_type, t.video_codec, mf.audio_bytes + mf.proxy_bytes + mf.reserve_bytes as freed
             from media_files mf join torrents t on t.id = mf.torrent_id join movies mv on mv.id = t.movie_id
            where mf.id = $1 and t.want <> 'remove'
              and (mf.audio_state <> 'none' or mf.proxy_state <> 'none' or mf.audio_bytes + mf.proxy_bytes + mf.reserve_bytes > 0)
            for update of mf`,
          [id],
        );
        if (!m) throw new ApiError('NOT_FOUND', 'no preview to delete');
        // A job converting it notices within two seconds that its asset is no longer running and stops
        // (docs/08-media-pipeline.md). It is not made again automatically.
        await c.query(
          `update media_files set audio_state = 'none', proxy_state = 'none', audio_bytes = 0, proxy_bytes = 0, reserve_bytes = 0,
                  proxy_progress = 0, updated_at = now() where id = $1`,
          [id],
        );
        const n = await tellHolders(c, m.torrent_id, admin, 'preview', m.title, versionLabel(m));
        await audit(c, admin, 'admin.storage.delete', { itemKind: 'preview', movieTitle: m.title }, req.ip);
        return { freed: m.freed, notes: n, torrentId: m.torrent_id };
      });
      await removePreviewFiles(config.dataDir, id, log);
      freedBytes = out.freed;
      notes = out.notes;
      await pool.query(`select pg_notify('paiban_events', $1)`, [
        JSON.stringify({ type: 'torrent', id: out.torrentId }),
      ]);
    } else if (kind === 'export') {
      const out = await tx(pool, async (c) => {
        const e = await one<{
          state: string;
          size_bytes: number;
          reserved_bytes: number;
          created_by: string | null;
          movie_title: string;
          file_name: string;
        }>(
          c,
          'select state, size_bytes, reserved_bytes, created_by, movie_title, file_name from exports where id = $1 for update',
          [id],
        );
        if (!e) throw new ApiError('NOT_FOUND', 'no such export');
        const n: number[] = [];
        if (e.created_by && e.created_by !== admin.id) {
          const r = await one<{ id: number }>(
            c,
            `insert into notifications (user_id, kind, data, link) values ($1, 'item.deleted', jsonb_build_object('actor', $2::text, 'itemKind', 'export', 'fileName', $3::text, 'movieTitle', $4::text), null) returning id`,
            [e.created_by, admin.displayName, e.file_name, e.movie_title],
          );
          if (r) n.push(r.id);
        }
        // Being written: ask the media service to stop; it removes its own half-written file and the row.
        if (e.state === 'running') await c.query('update exports set cancel_requested = true where id = $1', [id]);
        else {
          await c.query('delete from exports where id = $1', [id]);
          await c.query(
            `update tasks set state = 'cancelled', finished_at = now() where kind = 'export' and input->>'exportId' = $1 and state in ('queued', 'running')`,
            [id],
          );
        }
        await audit(
          c,
          admin,
          'admin.storage.delete',
          { itemKind: 'export', movieTitle: e.movie_title, fileName: e.file_name },
          req.ip,
        );
        return {
          freed: e.state === 'done' ? e.size_bytes : e.reserved_bytes,
          notes: n,
          running: e.state === 'running',
        };
      });
      if (!out.running) await removeExportFiles(config.dataDir, id, log);
      else await pool.query(`select pg_notify('paiban_media', '{}')`);
      deps.events.toAll({ type: 'export.removed', id });
      freedBytes = out.freed;
      notes = out.notes;
    } else {
      const f = await one<{
        root: 'torrents' | 'media' | 'subtitles' | 'candidates' | 'exports';
        name: string;
        bytes: number;
      }>(pool, `select root, name, bytes from storage_findings where id = $1 and kind = 'orphan'`, [id]);
      if (!f) throw new ApiError('NOT_FOUND', 'no such orphan');
      // Check again right before deleting that the folder still belongs to nothing.
      const table = {
        torrents: ['torrents', 'info_hash'],
        media: ['media_files', 'id::text'],
        subtitles: ['subtitles', 'id::text'],
        candidates: ['subtitle_candidates', 'id::text'],
        exports: ['exports', 'id::text'],
      }[f.root];
      const owner = await one(pool, `select 1 from ${table[0]} where ${table[1]} = $1`, [f.name]);
      if (owner) throw new ApiError('TORRENT_STATE', 'the folder belongs to a record now');
      await removeOrphanFolder(config.dataDir, f.root, f.name, log);
      await pool.query('delete from storage_findings where id = $1', [id]);
      await audit(pool, admin, 'admin.storage.delete', { itemKind: 'orphan', fileName: `${f.root}/${f.name}` }, req.ip);
      // Disk space freed. Orphans never counted toward the limit (docs/10-storage.md), so usage stays.
      freedBytes = f.bytes;
    }

    if (removedTorrent) {
      await pool.query(`select pg_notify('paiban_torrent', $1)`, [JSON.stringify({ id: removedTorrent })]);
      deps.events.toAll({ type: 'torrent.removed', id: removedTorrent });
    }
    for (const n of notes) await publishNotification(pool, deps.events, n);
    await publishUsage(pool, deps.events);
    deps.events.toAdmins({ type: 'admin', what: 'storage' });
    return { freedBytes };
  });
}
