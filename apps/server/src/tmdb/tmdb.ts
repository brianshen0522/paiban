import type { Logger } from 'pino';
import { z } from 'zod';
import { many, type Pool, type Queryable } from '../db/pool.js';
import { OutboundError, type OutboundPolicy, outboundFetch } from '../net/outbound.js';
import { recordSourceHealth } from '../settings/health.js';

/**
 * TMDB, the film information shown to people (Brian, 2026-10-06: "use TMDB, replace IMDb"):
 * the Chinese title and overview, the poster and the rating. One `find` by the IMDb code YTS gives
 * answers all of it; the IMDb code itself stays only as the key YTS and YIFY Subtitles know a film
 * by. Without a key nothing here is asked and pages fall back to what YTS says.
 */
export type TmdbEnv = {
  pool: Pool;
  outbound: OutboundPolicy;
  log: Logger;
  /** The `tmdbKey` secret, or null. */
  key: () => Promise<string | null>;
};

export type TmdbFilm = {
  tmdbId: number;
  /** The zh-TW title, when TMDB has one that is not just the original title. */
  titleZh: string | null;
  /** The zh-TW overview, or null when TMDB has none in Chinese. */
  overview: string | null;
  posterPath: string | null;
  /** Null when too few people voted for the figure to mean anything. */
  rating: number | null;
  voteCount: number;
};

export const TMDB_HOST = 'api.themoviedb.org';
export const TMDB_IMAGE_HOST = 'image.tmdb.org';
/** Fewer votes than this and TMDB's average is noise; the page shows YTS's figure instead. */
const MIN_VOTES = 5;
const FILM_DAYS = 7;
const UNKNOWN_HOURS = 24;

/** A v4 read token is long and has two dots (a JWT); anything else is a v3 key that goes in the query. */
export const isV4Token = (key: string) => key.length > 60 && key.split('.').length === 3;

export class TmdbError extends Error {
  readonly code: 'INVALID_KEY' | 'UNREACHABLE' | 'BAD_RESPONSE';
  constructor(code: TmdbError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

/** GET /3/find/<imdb>?external_source=imdb_id&language=zh-TW, as parsed JSON. */
export async function tmdbFind(outbound: OutboundPolicy, imdb: string, key: string): Promise<unknown> {
  const v4 = isV4Token(key);
  const url = `https://${TMDB_HOST}/3/find/${encodeURIComponent(imdb)}?external_source=imdb_id&language=zh-TW${
    v4 ? '' : `&api_key=${encodeURIComponent(key)}`
  }`;
  let res: Awaited<ReturnType<typeof outboundFetch>>;
  try {
    res = await outboundFetch(outbound, url, {
      allow: (h) => h === TMDB_HOST,
      maxBytes: 256 * 1024,
      timeoutMs: 8_000,
      ...(v4 ? { headers: { Authorization: `Bearer ${key}` } } : {}),
    });
  } catch (err) {
    if (err instanceof OutboundError) throw new TmdbError('UNREACHABLE', err.message);
    throw err;
  }
  if (res.status === 401) throw new TmdbError('INVALID_KEY', 'TMDB refused the key');
  if (res.status !== 200) throw new TmdbError('UNREACHABLE', `TMDB answered ${res.status}`);
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    throw new TmdbError('BAD_RESPONSE', 'TMDB answered something that is not JSON');
  }
}

const FindAnswer = z.object({
  movie_results: z.array(
    z.object({
      id: z.number(),
      title: z.string().nullish(),
      original_title: z.string().nullish(),
      overview: z.string().nullish(),
      poster_path: z.string().nullish(),
      vote_average: z.number().nullish(),
      vote_count: z.number().nullish(),
    }),
  ),
});

/** The first movie of a find answer; null when TMDB does not know the IMDb code. */
export function parseFind(body: unknown, originalTitle: string): TmdbFilm | null {
  const r = FindAnswer.safeParse(body);
  if (!r.success) throw new TmdbError('BAD_RESPONSE', 'not the find answer');
  const m = r.data.movie_results[0];
  if (!m) return null;
  const title = m.title?.trim() || null;
  const original = [originalTitle, m.original_title ?? ''].map((s) => s.trim().toLowerCase());
  const votes = m.vote_count ?? 0;
  const poster = m.poster_path && /^\/[\w.-]+$/.test(m.poster_path) ? m.poster_path : null;
  return {
    tmdbId: m.id,
    titleZh: title && !original.includes(title.toLowerCase()) ? title : null,
    overview: m.overview?.trim() || null,
    posterPath: poster,
    rating: votes >= MIN_VOTES && m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    voteCount: votes,
  };
}

const cacheKey = (imdb: string) => `film:${imdb}`;

/** What is cached and still fresh, by IMDb code. A null value means TMDB does not know the film. */
export async function cachedFilms(pool: Pool, imdbs: readonly string[]): Promise<Map<string, TmdbFilm | null>> {
  if (!imdbs.length) return new Map();
  const rows = await many<{ cache_key: string; payload: { film: TmdbFilm | null } }>(
    pool,
    `select cache_key, payload from provider_cache where provider = 'tmdb' and cache_key = any($1::text[]) and expires_at > now()`,
    [imdbs.map(cacheKey)],
  );
  return new Map(rows.map((r) => [r.cache_key.slice('film:'.length), r.payload.film]));
}

/**
 * Asks TMDB about one film, keeps the answer (a week; a day for "unknown"), and writes the TMDB id
 * and the Chinese title onto our own row for the film, when we have one. Null without a key.
 */
export async function fetchFilm(env: TmdbEnv, imdb: string, originalTitle: string): Promise<TmdbFilm | null> {
  const key = await env.key();
  if (!key) return null;
  let film: TmdbFilm | null;
  try {
    film = parseFind(await tmdbFind(env.outbound, imdb, key), originalTitle);
  } catch (err) {
    if (err instanceof TmdbError) {
      await recordSourceHealth(env.pool, 'tmdb', err.code === 'INVALID_KEY' ? 'warn' : 'down', err.code, {});
      env.log.warn({ imdb, code: err.code }, 'TMDB lookup failed');
      return null;
    }
    throw err;
  }
  await env.pool.query(
    `insert into provider_cache (provider, cache_key, payload, expires_at)
     values ('tmdb', $1, $2, now() + make_interval(hours => $3))
     on conflict (provider, cache_key) do update set payload = excluded.payload, fetched_at = now(), expires_at = excluded.expires_at`,
    [cacheKey(imdb), { film }, film ? FILM_DAYS * 24 : UNKNOWN_HOURS],
  );
  if (film)
    await env.pool.query('update movies set tmdb_id = $2, title_zh = coalesce($3, title_zh) where imdb_code = $1', [
      imdb,
      film.tmdbId,
      film.titleZh,
    ]);
  return film;
}

/**
 * Copies a cached TMDB answer onto our row for the film when the row does not have it yet: the row
 * is created when a download starts, usually after the film page already looked the film up.
 */
export async function applyCachedFilm(q: Queryable, imdb: string): Promise<void> {
  await q.query(
    `update movies m set tmdb_id = (c.payload->'film'->>'tmdbId')::int,
            title_zh = coalesce(c.payload->'film'->>'titleZh', m.title_zh)
       from provider_cache c
      where m.imdb_code = $1 and m.tmdb_id is null
        and c.provider = 'tmdb' and c.cache_key = 'film:' || $1 and c.expires_at > now()
        and c.payload->'film' <> 'null'::jsonb`,
    [imdb],
  );
}

/** One film: the cached answer, otherwise TMDB. */
export async function tmdbFilm(env: TmdbEnv, imdb: string, originalTitle: string): Promise<TmdbFilm | null> {
  const cached = await cachedFilms(env.pool, [imdb]);
  if (cached.has(imdb)) {
    await applyCachedFilm(env.pool, imdb);
    return cached.get(imdb) ?? null;
  }
  return fetchFilm(env, imdb, originalTitle);
}

/**
 * Many films (a search page): cached answers at once, the rest asked a few at a time. What has
 * not arrived after `budgetMs` is left out of this answer, and keeps loading into the cache for
 * the next one, so a slow TMDB never holds a search page up for long.
 */
export async function filmsFor(
  env: TmdbEnv,
  films: readonly { imdb: string; title: string }[],
  budgetMs = 2_500,
): Promise<Map<string, TmdbFilm | null>> {
  const out = await cachedFilms(
    env.pool,
    films.map((f) => f.imdb),
  );
  const missing = films.filter((f) => !out.has(f.imdb));
  if (!missing.length || !(await env.key())) return out;
  let next = 0;
  const worker = async () => {
    while (next < missing.length) {
      const f = missing[next++];
      if (!f) break;
      const film = await fetchFilm(env, f.imdb, f.title).catch(() => null);
      out.set(f.imdb, film);
    }
  };
  const all = Promise.all(Array.from({ length: Math.min(6, missing.length) }, worker));
  await Promise.race([all, new Promise((r) => setTimeout(r, budgetMs))]);
  return new Map(out);
}

export const tmdbPosterUrl = (posterPath: string) => `https://${TMDB_IMAGE_HOST}/t/p/w342${posterPath}`;
export const tmdbPageUrl = (tmdbId: number) => `https://www.themoviedb.org/movie/${tmdbId}`;
