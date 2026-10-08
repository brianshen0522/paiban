import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { type MovieDetail, type MovieSummary, SEARCH_PAGE_SIZE, type Version } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { OutboundError, outboundFetch } from '../net/outbound.js';
import { recordSourceHealth } from '../settings/health.js';
import { readSecret } from '../settings/secrets.js';
import { readSettings } from '../settings/settings.js';
import { predictDirectPlay, previewPlan, readUsage } from '../storage/usage.js';
import {
  filmsFor,
  TMDB_IMAGE_HOST,
  type TmdbEnv,
  type TmdbFilm,
  tmdbFilm,
  tmdbPageUrl,
  tmdbPosterUrl,
} from '../tmdb/tmdb.js';
import { posterUrl, selectTorrents, statusOf } from '../torrents/view.js';
import { cacheGet, cachePut, YtsClient, type YtsMovie, type YtsPage } from './client.js';

export function tmdbEnv(deps: Deps): TmdbEnv {
  return { pool: deps.pool, outbound: deps.outbound, log: deps.log, key: () => readSecret(deps, 'tmdbKey') };
}

export async function ytsClient(deps: Deps): Promise<YtsClient> {
  const { yts } = await readSettings(deps.pool);
  if (!yts.baseUrl) throw new ApiError('YTS_NOT_CONFIGURED', 'the YTS address has not been set');
  return new YtsClient(deps.outbound, yts.baseUrl);
}

/** Runs a YTS call and keeps the source's health row current (docs/07, "來源狀況"). */
export async function tracked<T>(deps: Deps, fn: () => Promise<T>): Promise<T> {
  try {
    const out = await fn();
    await recordSourceHealth(deps.pool, 'yts', 'ok', 'OK', {});
    return out;
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'YTS_UNREACHABLE' || err.code === 'YTS_BAD_RESPONSE')) {
      await recordSourceHealth(
        deps.pool,
        'yts',
        'down',
        err.code === 'YTS_UNREACHABLE' ? 'UNREACHABLE' : 'BAD_RESPONSE',
        {},
      );
    }
    throw err;
  }
}

/** A film by YTS id: fresh cache, else YTS, else (YTS down) whatever was stored before, marked stale. */
export async function getMovie(
  deps: Deps,
  ytsId: number,
): Promise<{ movie: YtsMovie; fetchedAt: Date; stale: boolean }> {
  const key = `movie:${ytsId}`;
  const cached = await cacheGet<YtsMovie>(deps.pool, key);
  if (cached) return { movie: cached.value, fetchedAt: cached.fetchedAt, stale: false };
  try {
    const client = await ytsClient(deps);
    const movie = await tracked(deps, () => client.movie(ytsId));
    if (!movie || movie.ytsId !== ytsId) throw new ApiError('NOT_FOUND', `YTS has no film ${ytsId}`);
    const fetchedAt = await cachePut(deps.pool, key, movie, 60);
    return { movie, fetchedAt, stale: false };
  } catch (err) {
    if (err instanceof ApiError && (err.code === 'YTS_UNREACHABLE' || err.code === 'YTS_BAD_RESPONSE')) {
      const old = await cacheGet<YtsMovie>(deps.pool, key, true);
      if (old) return { movie: old.value, fetchedAt: old.fetchedAt, stale: true };
    }
    throw err;
  }
}

const SearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  quality: z.enum(['720p', '1080p', '2160p']).optional(),
  genre: z
    .string()
    .regex(/^[a-z-]{2,20}$/)
    .optional(),
  minRating: z.coerce.number().int().min(0).max(9).optional(),
  sort: z.enum(['added', 'rating', 'year', 'seeds']).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

export function ytsRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  app.get('/api/yts/movies', async (req) => {
    const user = requireUser(req);
    const p = parse(SearchQuery, req.query);
    const params = { ...p, q: p.q || undefined, limit: SEARCH_PAGE_SIZE };
    const client = await ytsClient(deps);
    const key = `search:${new URL(await baseUrl(deps)).host}:${JSON.stringify(params)}`;
    let page = (await cacheGet<YtsPage>(pool, key))?.value;
    if (!page) {
      page = await tracked(deps, () => client.search(params));
      await cachePut(pool, key, page, 10);
    }
    const ids = page.movies.map((m) => m.ytsId);
    const local = await many<{ yts_id: number; title_zh: string | null; mine: 'none' | 'downloading' | 'ready' }>(
      pool,
      `select m.yts_id, m.title_zh,
              case when bool_or(t.state = 'completed' and h.user_id is not null) then 'ready'
                   when bool_or(h.user_id is not null) then 'downloading' else 'none' end as mine
         from movies m
         left join torrents t on t.movie_id = m.id and t.want <> 'remove'
         left join torrent_holders h on h.torrent_id = t.id and h.user_id = $2
        where m.yts_id = any($1::int[]) group by m.yts_id, m.title_zh`,
      [ids, user.id],
    );
    const byId = new Map(local.map((l) => [l.yts_id, l]));
    const tmdb = await filmsFor(
      tmdbEnv(deps),
      page.movies.map((m) => ({ imdb: m.imdbCode, title: m.title })),
    );
    const items: MovieSummary[] = page.movies.map((m) => summary(m, byId.get(m.ytsId), tmdb.get(m.imdbCode)));
    return { items, total: page.total, page: p.page, pageSize: SEARCH_PAGE_SIZE };
  });

  app.get('/api/yts/movies/:ytsId', async (req) => {
    const user = requireUser(req);
    const { ytsId } = parse(z.object({ ytsId: z.coerce.number().int().positive() }), req.params);
    const { movie, fetchedAt, stale } = await getMovie(deps, ytsId);
    const [settings, usage] = await Promise.all([readSettings(pool), readUsage(pool)]);
    const hashes = movie.torrents.map((t) => t.hash);
    const rows = await selectTorrents(pool, 't.info_hash = any($1::text[])', [hashes]);
    const byHash = new Map(rows.map((r) => [r.info_hash, r]));
    const versions: Version[] = movie.torrents.map((t) => {
      const directPlay = predictDirectPlay(t.videoCodec, t.bitDepth);
      const previewBytes = previewPlan(directPlay, movie.runtimeMin, settings.media).bytes;
      const needBytes = t.sizeBytes + previewBytes;
      const row = byHash.get(t.hash);
      return {
        infoHash: t.hash,
        quality: t.quality,
        source: t.type,
        videoCodec: t.videoCodec,
        bitDepth: t.bitDepth,
        audio: t.audioChannels,
        sizeBytes: t.sizeBytes,
        seeds: t.seeds,
        peers: t.peers,
        uploadedAt: t.uploadedAt,
        directPlay,
        previewBytes,
        needBytes,
        local: row
          ? {
              kind: 'present',
              torrentId: row.id,
              status: statusOf(row.state, row.analysis_state),
              progress: row.progress,
              mine: row.holders.some((h) => h.id === user.id),
              holders: row.holders,
            }
          : {
              kind: 'none',
              fits: !usage.over && usage.freeBytes >= needBytes,
              shortBytes: Math.max(0, usage.usedBytes + needBytes - usage.limitBytes),
            },
      };
    });
    const zh = await one<{ title_zh: string | null }>(pool, 'select title_zh from movies where yts_id = $1', [ytsId]);
    const mine = rows.some((r) => r.state === 'completed' && r.holders.some((h) => h.id === user.id))
      ? 'ready'
      : rows.some((r) => r.holders.some((h) => h.id === user.id))
        ? 'downloading'
        : 'none';
    const film = await tmdbFilm(tmdbEnv(deps), movie.imdbCode, movie.title).catch(() => null);
    const detail: MovieDetail = {
      ...summary(movie, { title_zh: zh?.title_zh ?? null, mine }, film),
      summary: film?.overview ?? movie.summary,
      summaryEn: movie.summary,
      tmdbUrl: film ? tmdbPageUrl(film.tmdbId) : null,
      language: movie.language,
      versions,
      usage,
      stale,
      fetchedAt: fetchedAt.toISOString(),
    };
    return detail;
  });

  app.get('/api/yts/movies/:ytsId/poster', async (req, reply) => {
    requireUser(req);
    const { ytsId } = parse(z.object({ ytsId: z.coerce.number().int().positive() }), req.params);
    // Films in a library are served from the copy kept on disk, so a YTS move does not lose them.
    const kept = join(deps.config.dataDir, 'posters', `${ytsId}.jpg`);
    if (
      await access(kept).then(
        () => true,
        () => false,
      )
    ) {
      reply.header('Cache-Control', 'private, max-age=86400').type('image/jpeg');
      return reply.send(createReadStream(kept));
    }
    const image = await fetchPoster(deps, ytsId).catch(() => null);
    if (!image) throw new ApiError('NOT_FOUND', 'no poster');
    reply.header('Cache-Control', 'private, max-age=86400').type(image.type);
    return reply.send(image.body);
  });
}

async function baseUrl(deps: Deps): Promise<string> {
  return (await readSettings(deps.pool)).yts.baseUrl;
}

function summary(
  m: YtsMovie,
  local?: { title_zh: string | null; mine: 'none' | 'downloading' | 'ready' },
  film?: TmdbFilm | null,
): MovieSummary {
  const tmdbRating = film?.rating ?? null;
  return {
    ytsId: m.ytsId,
    imdbCode: m.imdbCode,
    tmdbId: film?.tmdbId ?? null,
    title: m.title,
    titleZh: film?.titleZh ?? local?.title_zh ?? null,
    year: m.year,
    runtimeMin: m.runtimeMin,
    rating: tmdbRating ?? m.rating,
    ratingSource: tmdbRating !== null ? 'tmdb' : 'imdb',
    genres: m.genres,
    posterUrl: posterUrl(m.ytsId),
    qualities: [...new Set(m.torrents.map((t) => t.quality))],
    mine: local?.mine ?? 'none',
  };
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * The poster through the server (D30). Only from the configured YTS host or one of its
 * subdomains, only images, at most 2 MB (docs/05-yts.md, "海報").
 */
export async function fetchPoster(deps: Deps, ytsId: number): Promise<{ type: string; body: Buffer } | null> {
  const base = await baseUrl(deps);
  if (!base) return null;
  const { movie } = await getMovie(deps, ytsId);
  // TMDB's poster first (Brian, 2026-10-06), YTS's cover when TMDB has none or no key is set.
  const film = await tmdbFilm(tmdbEnv(deps), movie.imdbCode, movie.title).catch(() => null);
  if (film?.posterPath) {
    const fromTmdb = await image(deps, tmdbPosterUrl(film.posterPath), (h) => h === TMDB_IMAGE_HOST);
    if (fromTmdb) return fromTmdb;
  }
  if (!movie.coverUrl) return null;
  const host = new URL(base).hostname;
  const allow = (h: string) => h === host || h.endsWith(`.${host}`);
  let url: URL;
  try {
    url = new URL(movie.coverUrl, base);
  } catch {
    return null;
  }
  if (!allow(url.hostname)) return null;
  // Redirects are followed only within the YTS host and its subdomains (yts.gg sends covers to
  // img.yts.gg); `allow` is checked again after every hop.
  return image(deps, url.toString(), allow);
}

/** One image from an allowed host: only images, at most 2 MB. */
async function image(
  deps: Deps,
  url: string,
  allow: (host: string) => boolean,
): Promise<{ type: string; body: Buffer } | null> {
  try {
    const res = await outboundFetch(deps.outbound, url, { allow, maxBytes: 2 * 1024 * 1024, timeoutMs: 10_000 });
    const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
    if (res.status !== 200 || !IMAGE_TYPES.includes(type)) return null;
    return { type, body: res.body };
  } catch (err) {
    if (err instanceof OutboundError) return null;
    throw err;
  }
}
