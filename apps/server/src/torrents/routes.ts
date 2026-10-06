import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Torrent, TorrentLive } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { type Client, one, pgCode, tx, UNIQUE_VIOLATION } from '../db/pool.js';
import { publishTorrent, publishUsage } from '../events/publish.js';
import { dropFilmExports, finishFilmExports } from '../exports/film-exports.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin, requireUser } from '../http/guards.js';
import { readSettings } from '../settings/settings.js';
import { admit, predictDirectPlay, previewPlan } from '../storage/usage.js';
import { applyCachedFilm } from '../tmdb/tmdb.js';
import { fetchPoster, getMovie } from '../yts/routes.js';
import { selectTorrents, type TorrentRow, toTorrent, versionLabel } from './view.js';

const IdParams = z.object({ id: z.uuid() });
const CreateBody = z.object({ ytsId: z.number().int().positive(), infoHash: z.string().regex(/^[0-9a-fA-F]{40}$/) });

/** The torrent row if the caller holds it; NOT_FOUND / NOT_HOLDER otherwise. Admins are no exception. */
export async function holderTorrent(deps: Deps, user: AuthedUser, id: string): Promise<TorrentRow> {
  const [row] = await selectTorrents(deps.pool, 't.id = $1', [id]);
  if (!row) throw new ApiError('NOT_FOUND', 'no such download');
  if (!row.holders.some((h) => h.id === user.id)) throw new ApiError('NOT_HOLDER', 'not a holder of this download');
  return row;
}

async function wake(deps: Deps, torrentId: string, usageChanged: boolean): Promise<void> {
  await deps.pool.query(`select pg_notify('paiban_torrent', $1)`, [JSON.stringify({ id: torrentId })]);
  await publishTorrent(deps.pool, deps.events, torrentId);
  if (usageChanged) await publishUsage(deps.pool, deps.events);
}

export function torrentRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config, disk } = deps;

  /**
   * Accept a download (docs/04-api.md, "接受下載"). Size, quality and codec come from YTS through the
   * server, never from the request, and the hash must be one YTS lists for that film (D26).
   */
  app.post('/api/torrents', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(CreateBody, req.body);
    const hash = body.infoHash.toLowerCase();
    const { movie } = await getMovie(deps, body.ytsId);
    const version = movie.torrents.find((t) => t.hash === hash);
    if (!version) throw new ApiError('HASH_NOT_FROM_YTS', 'that hash is not one of this film’s versions');
    const settings = await readSettings(pool);

    const attempt = (c: Client) => async (): Promise<{ id: string; joined: boolean }> => {
      const existing = await one<{ id: string; want: string }>(
        c,
        'select id, want from torrents where info_hash = $1 for update',
        [hash],
      );
      if (existing?.want === 'remove') throw new ApiError('TORRENT_STATE', 'this version is being deleted');
      if (existing) {
        await c.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2) on conflict do nothing', [
          existing.id,
          user.id,
        ]);
        return { id: existing.id, joined: true };
      }
      const plan = previewPlan(
        predictDirectPlay(version.videoCodec, version.bitDepth),
        movie.runtimeMin,
        settings.media,
      );
      await admit(c, disk, config.storageReserveBytes, {
        bytes: version.sizeBytes + plan.bytes,
        previewBytes: plan.bytes,
      });
      const m = await one<{ id: string }>(
        c,
        `insert into movies (yts_id, imdb_code, title, year, runtime_min, rating, genres, summary, language)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         on conflict (yts_id) do update set imdb_code = excluded.imdb_code, title = excluded.title, year = excluded.year,
           runtime_min = excluded.runtime_min, rating = excluded.rating, genres = excluded.genres, summary = excluded.summary,
           language = excluded.language, fetched_at = now()
         returning id`,
        [
          movie.ytsId,
          movie.imdbCode,
          movie.title,
          movie.year,
          movie.runtimeMin,
          movie.rating,
          movie.genres,
          movie.summary,
          movie.language,
        ],
      );
      // The film page usually looked it up on TMDB already: the new row gets that answer.
      await applyCachedFilm(c, movie.imdbCode);
      const t = await one<{ id: string }>(
        c,
        `insert into torrents (info_hash, movie_id, quality, source_type, video_codec, bit_depth, audio_channels, size_bytes,
                               preview_reserve_bytes, preview_proxy_res, requested_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [
          hash,
          m?.id,
          version.quality,
          version.type,
          version.videoCodec,
          version.bitDepth,
          version.audioChannels,
          version.sizeBytes,
          plan.bytes,
          plan.proxyRes,
          user.id,
        ],
      );
      if (!t) throw new Error('insert returned nothing');
      await c.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [t.id, user.id]);
      return { id: t.id, joined: false };
    };

    let result: { id: string; joined: boolean };
    try {
      result = await tx(pool, (c) => attempt(c)());
    } catch (err) {
      // Two people adding the same new version at once: the second insert hits the unique hash.
      // Run again; this time it finds the row and joins (docs/03-data-model.md, "交易的邊界").
      if (pgCode(err) !== UNIQUE_VIOLATION) throw err;
      result = await tx(pool, (c) => attempt(c)());
    }

    const [row] = await selectTorrents(pool, 't.id = $1', [result.id]);
    if (!row) throw new ApiError('NOT_FOUND', 'download disappeared');
    await audit(
      pool,
      user,
      result.joined ? 'torrent.join' : 'torrent.add',
      { movieTitle: movie.title, version: versionLabel(row) },
      req.ip,
    );
    if (!result.joined) void keepPoster(deps, movie.ytsId);
    await wake(deps, row.id, !result.joined);
    return reply.status(result.joined ? 200 : 201).send({ torrent: toTorrent(row, user.id), joined: result.joined });
  });

  app.get('/api/torrents', async (req) => {
    const user = requireUser(req);
    const { scope } = parse(z.object({ scope: z.enum(['mine', 'all']).default('mine') }), req.query);
    if (scope === 'all') requireAdmin(req);
    const rows =
      scope === 'all'
        ? await selectTorrents(pool, 'true', [])
        : await selectTorrents(
            pool,
            'exists (select 1 from torrent_holders h where h.torrent_id = t.id and h.user_id = $1)',
            [user.id],
          );
    return rows.map((r) => toTorrent(r, user.id));
  });

  app.get('/api/torrents/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    return toTorrent(await holderTorrent(deps, user, id), user.id);
  });

  /**
   * The detail page's live view (docs/11-pages.md, "下載細節"). Each call keeps the snapshot wanted
   * for ten more seconds; the torrent service writes one on its next pass (every 2 s). A snapshot
   * older than six seconds is not given out: the download has stopped running.
   */
  app.get('/api/torrents/:id/live', async (req): Promise<TorrentLive | null> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    await holderTorrent(deps, user, id);
    const row = await one<{ data: TorrentLive | null; fresh: boolean }>(
      pool,
      `insert into torrent_live (torrent_id, wanted_until) values ($1, now() + interval '10 seconds')
       on conflict (torrent_id) do update set wanted_until = excluded.wanted_until
       returning data, coalesce(updated_at > now() - interval '6 seconds', false) as fresh`,
      [id],
    );
    return row?.fresh ? row.data : null;
  });

  /** pause/resume only write `want`; the torrent worker makes `state` follow (docs/06). */
  const setWant = (path: 'pause' | 'resume', from: TorrentRow['state'][], want: 'pause' | 'run', action: string) =>
    app.post(`/api/torrents/:id/${path}`, async (req): Promise<Torrent> => {
      const user = requireUser(req);
      const { id } = parse(IdParams, req.params);
      const row = await holderTorrent(deps, user, id);
      const r = await pool.query(
        `update torrents set want = $2 where id = $1 and want <> 'remove' and state = any($3::text[])`,
        [id, want, from],
      );
      if (r.rowCount === 0) throw new ApiError('TORRENT_STATE', `cannot ${path} a ${row.state} download`);
      await audit(pool, user, action, { movieTitle: row.title, version: versionLabel(row) }, req.ip);
      await wake(deps, id, false);
      const [after] = await selectTorrents(pool, 't.id = $1', [id]);
      return toTorrent(after ?? row, user.id);
    });
  setWant('pause', ['queued', 'downloading'], 'pause', 'torrent.pause');
  setWant('resume', ['paused'], 'run', 'torrent.resume');

  app.post('/api/torrents/:id/retry', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const row = await holderTorrent(deps, user, id);
    await tx(pool, async (c) => {
      const t = await one<{
        state: string;
        size_bytes: number;
        length_bytes: number | null;
        preview_reserve_bytes: number;
        disk_bytes: number;
      }>(
        c,
        `select state, size_bytes, length_bytes, preview_reserve_bytes, disk_bytes from torrents where id = $1 and want <> 'remove' for update`,
        [id],
      );
      if (t?.state !== 'failed') throw new ApiError('TORRENT_STATE', 'only a failed download can be retried');
      // The leftovers already on disk are released and reused: the retry continues from them.
      await admit(c, disk, config.storageReserveBytes, {
        bytes: Math.max(t.size_bytes, t.length_bytes ?? 0) + t.preview_reserve_bytes,
        previewBytes: t.preview_reserve_bytes,
        releaseBytes: t.disk_bytes,
        reusedOnDisk: t.disk_bytes,
      });
      await c.query(
        `update torrents set state = 'queued', want = 'run', queued_at = now(), error_code = null, error_message = null, phase = null where id = $1`,
        [id],
      );
    });
    await audit(pool, user, 'torrent.retry', { movieTitle: row.title, version: versionLabel(row) }, req.ip);
    await wake(deps, id, true);
    const [after] = await selectTorrents(pool, 't.id = $1', [id]);
    return toTorrent(after ?? row, user.id);
  });

  /** Leave a download. The last holder's leaving marks it for removal; the torrent worker deletes. */
  app.delete('/api/torrents/:id/hold', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const row = await holderTorrent(deps, user, id);
    const out = await tx(pool, async (c) => {
      const t = await one<{ id: string }>(c, `select id from torrents where id = $1 and want <> 'remove' for update`, [
        id,
      ]);
      if (!t) throw new ApiError('NOT_FOUND', 'no such download');
      await c.query('delete from torrent_holders where torrent_id = $1 and user_id = $2', [id, user.id]);
      const left = await one<{ n: number }>(c, 'select count(*)::int as n from torrent_holders where torrent_id = $1', [
        id,
      ]);
      if ((left?.n ?? 0) > 0) return { deleted: false, freedBytes: 0, exports: null };
      const freed = await one<{ n: number }>(
        c,
        `select case when t.state = 'completed' then t.disk_bytes + coalesce(mf.analysis_bytes + mf.audio_bytes + mf.proxy_bytes + mf.reserve_bytes, 0)
                     when t.state = 'failed' then t.disk_bytes
                     else greatest(t.size_bytes, coalesce(t.length_bytes, 0)) + t.preview_reserve_bytes end as n
           from torrents t left join media_files mf on mf.torrent_id = t.id where t.id = $1`,
        [id],
      );
      // The last holder deletes the whole film, its exports included (Brian, 2026-10-06).
      const exports = await dropFilmExports(c, id, user, req.ip);
      await c.query(`update torrents set want = 'remove' where id = $1`, [id]);
      return { deleted: true, freedBytes: (freed?.n ?? 0) + exports.freedBytes, exports };
    });
    if (out.exports) await finishFilmExports(deps, out.exports);
    await audit(
      pool,
      user,
      out.deleted ? 'torrent.delete' : 'torrent.leave',
      { movieTitle: row.title, version: versionLabel(row) },
      req.ip,
    );
    await pool.query(`select pg_notify('paiban_torrent', $1)`, [JSON.stringify({ id })]);
    if (out.deleted) deps.events.toAll({ type: 'torrent.removed', id });
    else await publishTorrent(pool, deps.events, id);
    return { deleted: out.deleted, freedBytes: out.freedBytes };
  });
}

/**
 * Keeps a copy of the poster under /data/posters once a film is downloaded, so the library does
 * not depend on YTS keeping its address (docs/05-yts.md). Best effort; written as .part, renamed.
 */
async function keepPoster(deps: Deps, ytsId: number): Promise<void> {
  try {
    const image = await fetchPoster(deps, ytsId);
    if (!image) return;
    const dir = join(deps.config.dataDir, 'posters');
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${ytsId}.jpg`);
    await writeFile(`${file}.part`, image.body);
    await rename(`${file}.part`, file);
    await deps.pool.query('update movies set poster_path = $2 where yts_id = $1', [ytsId, `posters/${ytsId}.jpg`]);
  } catch (err) {
    deps.log.warn({ err, ytsId }, 'could not keep the poster');
  }
}
