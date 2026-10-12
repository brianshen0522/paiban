import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Torrent, TorrentInspection, TorrentInvalidReason } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { type Client, one, pgCode, tx, UNIQUE_VIOLATION } from '../db/pool.js';
import { publishTorrent, publishUsage } from '../events/publish.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { keepPoster, keptPoster, RegionQuery } from '../posters/kept.js';
import { readSettings } from '../settings/settings.js';
import { admit, predictDirectPlay, previewPlan } from '../storage/usage.js';
import { type TmdbDetails, TmdbError, tmdbDetails, tmdbPosterImage, tmdbRegionPoster } from '../tmdb/tmdb.js';
import { pathsAreSafe, subtitleFiles } from '../torrent/schedule.js';
import { tmdbEnv } from '../yts/routes.js';
import {
  chosenFile,
  decodeMetainfo,
  guessVersion,
  MAX_TORRENT_FILE_BYTES,
  type Metainfo,
  MetainfoError,
  readMagnet,
  readTorrentFile,
} from './metainfo.js';
import { selectTorrents, toTorrent, versionLabel } from './view.js';

/**
 * Torrents added by hand (Brian, 2026-10-09; D26 changed; docs/06-torrent-worker.md, "Adding by hand"):
 * a magnet link or a .torrent file, inspected first so the person sees what will be downloaded,
 * then added with the film picked on TMDB. Only the largest video file is downloaded.
 */
const IdParams = z.object({ id: z.uuid() });
const MagnetBody = z.object({ magnet: z.string().trim().min(1).max(8000) });
const ManualBody = z.object({ inspectionId: z.uuid(), tmdbId: z.number().int().positive().max(100_000_000) });
/** Inspections one person may start in an hour (a magnet makes the torrent service join a swarm). */
export const INSPECTIONS_PER_HOUR = 30;
/** An inspection older than this cannot be added any more: inspect the link again. */
const INSPECTION_HOURS = 24;

type InspectionRow = {
  id: string;
  created_by: string | null;
  created_at: Date;
  source: 'magnet' | 'file';
  info_hash: string;
  trackers: string[];
  state: 'pending' | 'ready' | 'failed';
  error_code: string | null;
  metainfo: Buffer | null;
};

/** The film's name and year, read from a release name ("Night.of.the.Living.Dead.1968.1080p…"). */
export function titleGuess(name: string): { title: string; year: number | null } {
  const clean = name.replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[._]+/g, ' ');
  // The last year-like number with something in front of it ("Blade Runner 2049 (2017)" is 2017).
  const years = [...clean.matchAll(/(?:^|[\s([])((?:19|20)\d{2})(?=$|[\s)\]])/g)].filter((m) => (m.index ?? 0) > 0);
  const year = years.at(-1);
  const words = clean.search(
    /[\s([](?:2160p|1080p|720p|480p|4k|uhd|bluray|blu-ray|web|webrip|web-dl|hdtv|x264|x265|hevc)\b/i,
  );
  const cuts = [year?.index ?? -1, words].filter((n) => n > 0);
  const cut = cuts.length ? Math.min(...cuts) : -1;
  const title = (cut > 0 ? clean.slice(0, cut) : clean)
    .replace(/[[\]()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { title: title.slice(0, 100), year: year?.[1] ? Number(year[1]) : null };
}

/** What a stored inspection says, with what makes it unusable worked out from its metainfo. */
async function view(deps: Deps, user: AuthedUser, r: InspectionRow): Promise<TorrentInspection> {
  const [existing] = await selectTorrents(deps.pool, 't.info_hash = $1', [r.info_hash]);
  let meta: Metainfo | null = null;
  let error = r.error_code as TorrentInvalidReason | null;
  if (r.metainfo) {
    try {
      meta = await decodeMetainfo(r.metainfo);
    } catch {
      error = 'BAD_TORRENT';
    }
  }
  const file = meta ? chosenFile(meta) : null;
  const subs = meta && file ? subtitleFiles(meta.files.filter((f) => f !== file)) : [];
  if (meta && !error) {
    const dir = '/data/torrents/x';
    if (!pathsAreSafe(dir, meta.files, resolve, sep)) error = 'UNSAFE_PATH';
    else if (!file) error = 'NO_VIDEO_FILE';
  }
  const name = meta?.name || null;
  return {
    id: r.id,
    source: r.source,
    infoHash: r.info_hash,
    state: error ? 'failed' : r.state === 'ready' && meta ? 'ready' : r.state === 'failed' ? 'failed' : 'pending',
    errorCode: error ?? (r.state === 'failed' ? 'NO_METADATA' : null),
    name,
    file: file ? { path: file.path, sizeBytes: file.length } : null,
    subtitleFiles: subs.length,
    skippedFiles: meta ? meta.files.length - (file ? 1 : 0) - subs.length : 0,
    version: guessVersion(`${name ?? ''} ${file?.path ?? ''}`),
    guess: titleGuess(name ?? file?.path ?? ''),
    existing: existing ? toTorrent(existing, user.id) : null,
    createdAt: r.created_at.toISOString(),
  };
}

async function ownInspection(deps: Deps, user: AuthedUser, id: string): Promise<InspectionRow> {
  const r = await one<InspectionRow>(
    deps.pool,
    `select id, created_by, created_at, source, info_hash, trackers, state, error_code, metainfo
       from torrent_inspections where id = $1 and created_by = $2`,
    [id, user.id],
  );
  if (!r) throw new ApiError('NOT_FOUND', 'no such inspection');
  return r;
}

const invalid = (reason: TorrentInvalidReason, message: string) => new ApiError('TORRENT_INVALID', message, { reason });

/**
 * Keeps the TMDB poster of a film added by hand under /data/posters (as keepPoster does for YTS),
 * so the library does not depend on TMDB. Best effort; written as .part, renamed.
 */
async function keepTmdbPoster(deps: Deps, movieId: string, film: TmdbDetails): Promise<void> {
  if (!film.posterPath) return;
  try {
    const image = await tmdbPosterImage(deps, film.posterPath);
    if (!image) return;
    const dir = join(deps.config.dataDir, 'posters');
    await mkdir(dir, { recursive: true });
    const name = `tmdb-${film.tmdbId}.${image.ext}`;
    await writeFile(join(dir, `${name}.part`), image.body);
    await rename(join(dir, `${name}.part`), join(dir, name));
    await deps.pool.query('update movies set poster_path = $2 where id = $1 and yts_id is null', [
      movieId,
      `posters/${name}`,
    ]);
  } catch (err) {
    deps.log.warn({ err, tmdbId: film.tmdbId }, 'could not keep the poster');
  }
}

/** The film row a torrent added by hand belongs to: the one YTS films use when TMDB's IMDb code matches, else its own. */
async function filmRow(c: Client, film: TmdbDetails): Promise<string> {
  if (film.imdb) {
    const byImdb = await one<{ id: string }>(
      c,
      'select id from movies where imdb_code = $1 order by yts_id nulls last limit 1',
      [film.imdb],
    );
    if (byImdb) return byImdb.id;
  }
  const values = [
    film.imdb ?? '',
    film.tmdbId,
    film.title,
    film.titleZh,
    film.year,
    film.runtimeMin,
    film.rating,
    film.genres,
    film.overview,
    film.language,
  ];
  const row = await one<{ id: string }>(
    c,
    `insert into movies (yts_id, imdb_code, tmdb_id, title, title_zh, year, runtime_min, rating, genres, summary, language)
     values (null, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (tmdb_id) where yts_id is null do update set imdb_code = excluded.imdb_code, title = excluded.title,
       title_zh = excluded.title_zh, year = excluded.year, runtime_min = excluded.runtime_min, rating = excluded.rating,
       genres = excluded.genres, summary = excluded.summary, language = excluded.language, fetched_at = now()
     returning id`,
    values,
  );
  if (!row) throw new Error('insert returned nothing');
  return row.id;
}

export function manualTorrentRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config, disk } = deps;

  /** A magnet link (JSON) or a .torrent file (multipart, field "file"): what it holds. */
  app.post('/api/torrents/inspect', async (req, reply): Promise<TorrentInspection> => {
    const user = requireUser(req);
    const recent = await one<{ n: number }>(
      pool,
      `select count(*)::int as n from torrent_inspections where created_by = $1 and created_at > now() - interval '1 hour'`,
      [user.id],
    );
    if ((recent?.n ?? 0) >= INSPECTIONS_PER_HOUR)
      throw new ApiError('RATE_LIMITED', 'too many torrents inspected in an hour', { retryAfterSeconds: 600 });

    let row: InspectionRow | null;
    try {
      if (req.isMultipart()) {
        const file = await req.file({ limits: { fileSize: MAX_TORRENT_FILE_BYTES, files: 1 } });
        if (!file) throw new ApiError('VALIDATION', 'no file', { fields: { file: 'REQUIRED' } });
        const bytes = await file.toBuffer();
        const { meta, trackers } = await readTorrentFile(bytes);
        row = await one<InspectionRow>(
          pool,
          `insert into torrent_inspections (created_by, source, info_hash, trackers, state, metainfo, finished_at)
           values ($1, 'file', $2, $3, 'ready', $4, now())
           returning id, created_by, created_at, source, info_hash, trackers, state, error_code, metainfo`,
          [user.id, meta.infoHash, trackers, meta.metainfo],
        );
      } else {
        const { magnet } = parse(MagnetBody, req.body);
        const { infoHash, trackers } = await readMagnet(magnet);
        // Already on the site, or a file this person inspected: no need to ask the swarm again.
        const known = await one<{ metainfo: Buffer | null }>(
          pool,
          `select coalesce((select metainfo from torrents where info_hash = $1 and metainfo is not null),
                           (select metainfo from torrent_inspections where info_hash = $1 and metainfo is not null
                             order by created_at desc limit 1)) as metainfo`,
          [infoHash],
        );
        row = await one<InspectionRow>(
          pool,
          `insert into torrent_inspections (created_by, source, info_hash, trackers, state, metainfo, finished_at)
           values ($1, 'magnet', $2, $3, $4, $5, case when $5::bytea is null then null else now() end)
           returning id, created_by, created_at, source, info_hash, trackers, state, error_code, metainfo`,
          [user.id, infoHash, trackers, known?.metainfo ? 'ready' : 'pending', known?.metainfo ?? null],
        );
        if (row?.state === 'pending') await pool.query(`select pg_notify('paiban_inspect', $1)`, [row.id]);
      }
    } catch (err) {
      if (err instanceof MetainfoError) throw invalid(err.code, err.message);
      throw err;
    }
    if (!row) throw new Error('insert returned nothing');
    return reply.status(201).send(await view(deps, user, row));
  });

  app.get('/api/torrents/inspect/:id', async (req): Promise<TorrentInspection> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    return view(deps, user, await ownInspection(deps, user, id));
  });

  /** Adds the inspected torrent as the film picked on TMDB (docs/04-api.md, "Adding by hand"). */
  app.post('/api/torrents/manual', async (req, reply): Promise<{ torrent: Torrent; joined: boolean }> => {
    const user = requireUser(req);
    const body = parse(ManualBody, req.body);
    const ins = await ownInspection(deps, user, body.inspectionId);
    const seen = await view(deps, user, ins);
    if (seen.state === 'pending') throw new ApiError('TORRENT_STATE', 'the metadata is not in yet');
    if (seen.state === 'failed' || !ins.metainfo || !seen.file)
      throw invalid(seen.errorCode ?? 'BAD_TORRENT', 'this torrent cannot be added');
    if (Date.now() - ins.created_at.getTime() > INSPECTION_HOURS * 3600_000)
      throw new ApiError('NOT_FOUND', 'the inspection is too old; inspect the link again');

    let film: TmdbDetails | null;
    try {
      film = await tmdbDetails(tmdbEnv(deps), body.tmdbId);
    } catch (err) {
      if (err instanceof TmdbError) throw new ApiError('TMDB_UNREACHABLE', `TMDB: ${err.code}`);
      throw err;
    }
    if (film === null && !(await tmdbEnv(deps).key())) throw new ApiError('TMDB_NOT_CONFIGURED', 'no TMDB key');
    if (!film) throw new ApiError('VALIDATION', 'TMDB has no such film', { fields: { tmdbId: 'NOT_FOUND' } });
    const details = film;
    const settings = await readSettings(pool);
    // The video and the subtitle files beside it (tiny, but counted all the same).
    const meta = await decodeMetainfo(ins.metainfo);
    const main = chosenFile(meta);
    const size =
      (main?.length ?? seen.file.sizeBytes) +
      subtitleFiles(meta.files.filter((f) => f !== main)).reduce((n, f) => n + f.length, 0);
    const v = seen.version;
    const playable = predictDirectPlay(v.videoCodec, v.bitDepth) && /\.(mp4|m4v)$/i.test(seen.file.path);
    const plan = previewPlan(playable, details.runtimeMin, settings.media);
    const metainfo = ins.metainfo;

    const attempt = async (c: Client): Promise<{ id: string; joined: boolean; movieId: string }> => {
      const existing = await one<{ id: string; want: string; movie_id: string }>(
        c,
        'select id, want, movie_id from torrents where info_hash = $1 for update',
        [ins.info_hash],
      );
      if (existing?.want === 'remove') throw new ApiError('TORRENT_STATE', 'this torrent is being deleted');
      if (existing) {
        await c.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2) on conflict do nothing', [
          existing.id,
          user.id,
        ]);
        return { id: existing.id, joined: true, movieId: existing.movie_id };
      }
      await admit(c, disk, config.storageReserveBytes, { bytes: size + plan.bytes, previewBytes: plan.bytes });
      const movieId = await filmRow(c, details);
      const t = await one<{ id: string }>(
        c,
        `insert into torrents (info_hash, movie_id, quality, source_type, video_codec, bit_depth, size_bytes, length_bytes,
                               preview_reserve_bytes, preview_proxy_res, requested_by, origin, metainfo, trackers)
         values ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10, 'manual', $11, $12) returning id`,
        [
          ins.info_hash,
          movieId,
          v.quality,
          v.source,
          v.videoCodec,
          v.bitDepth,
          size,
          plan.bytes,
          plan.proxyRes,
          user.id,
          metainfo,
          ins.trackers,
        ],
      );
      if (!t) throw new Error('insert returned nothing');
      await c.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [t.id, user.id]);
      return { id: t.id, joined: false, movieId };
    };

    let result: { id: string; joined: boolean; movieId: string };
    try {
      result = await tx(pool, attempt);
    } catch (err) {
      // Two people adding the same torrent at once: run again; this time it joins.
      if (pgCode(err) !== UNIQUE_VIOLATION) throw err;
      result = await tx(pool, attempt);
    }
    // The inspection is used up (a row, not a file).
    await pool.query('delete from torrent_inspections where id = $1', [ins.id]);
    const [row] = await selectTorrents(pool, 't.id = $1', [result.id]);
    if (!row) throw new ApiError('NOT_FOUND', 'download disappeared');
    await audit(
      pool,
      user,
      result.joined ? 'torrent.join' : 'torrent.manual',
      { movieTitle: row.title, version: versionLabel(row) },
      req.ip,
    );
    if (!result.joined && row.yts_id === null) void keepTmdbPoster(deps, result.movieId, details);
    await pool.query(`select pg_notify('paiban_torrent', $1)`, [JSON.stringify({ id: row.id })]);
    await publishTorrent(pool, deps.events, row.id);
    if (!result.joined) await publishUsage(pool, deps.events);
    return reply.status(result.joined ? 200 : 201).send({ torrent: toTorrent(row, user.id), joined: result.joined });
  });

  /**
   * The poster of a film added by hand (YTS films use /api/yts/movies/:ytsId/poster), in the
   * country the person chose (Brian, 2026-10-10): a kept copy, else TMDB's (then kept), else the
   * copy kept when the film was added.
   */
  app.get('/api/movies/:id/poster', async (req, reply) => {
    requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { region } = parse(RegionQuery, req.query);
    const m = await one<{ tmdb_id: number | null }>(
      pool,
      'select tmdb_id from movies where id = $1 and yts_id is null',
      [id],
    );
    if (!m?.tmdb_id) throw new ApiError('NOT_FOUND', 'no poster');
    const stem = `tmdb-${m.tmdb_id}`;
    const send = async (kept: { path: string; type: string }) => {
      reply.header('Cache-Control', 'private, max-age=86400').type(kept.type);
      return reply.send(await readFile(kept.path));
    };
    const regional = await keptPoster(config.dataDir, `${stem}-${region}`);
    if (regional) return send(regional);
    const path = await tmdbRegionPoster(tmdbEnv(deps), m.tmdb_id, region).catch(() => null);
    const image = path ? await tmdbPosterImage(deps, path).catch(() => null) : null;
    if (image) {
      const type = image.ext === 'png' ? 'image/png' : image.ext === 'webp' ? 'image/webp' : 'image/jpeg';
      await keepPoster(config.dataDir, `${stem}-${region}`, { type, body: image.body });
      reply.header('Cache-Control', 'private, max-age=86400').type(type);
      return reply.send(image.body);
    }
    const added = await keptPoster(config.dataDir, stem);
    if (added) return send(added);
    throw new ApiError('NOT_FOUND', 'no poster');
  });
}
