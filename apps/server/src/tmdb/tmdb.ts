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
  const body = await tmdbGet(
    outbound,
    `/3/find/${encodeURIComponent(imdb)}`,
    { external_source: 'imdb_id', language: 'zh-TW' },
    key,
  );
  if (body === null) throw new TmdbError('UNREACHABLE', 'TMDB answered 404 to a find');
  return body;
}

/** One GET to TMDB's API, as parsed JSON. A v3 key goes in the query, a v4 token in a header. */
export async function tmdbGet(
  outbound: OutboundPolicy,
  path: string,
  query: Record<string, string>,
  key: string,
): Promise<unknown> {
  const v4 = isV4Token(key);
  const params = new URLSearchParams(query);
  if (!v4) params.set('api_key', key);
  const url = `https://${TMDB_HOST}${path}?${params}`;
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
  if (res.status === 404) return null;
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

/* ------------------------------------------------------------------ suggestions as you type */

/** A suggestion as kept in the cache: the poster as TMDB's path, turned into our URL on the way out. */
export type TmdbHit = {
  tmdbId: number;
  title: string;
  originalTitle: string;
  year: number | null;
  posterPath: string | null;
};

const SearchAnswer = z.object({
  results: z.array(
    z.object({
      id: z.number(),
      title: z.string().nullish(),
      original_title: z.string().nullish(),
      release_date: z.string().nullish(),
      poster_path: z.string().nullish(),
      adult: z.boolean().nullish(),
    }),
  ),
});

/** At most this many suggestions under the search box. */
export const SUGGEST_LIMIT = 8;
const SUGGEST_HOURS = 24;
const IMDB_DAYS = 30;
/** TMDB's poster paths look like "/kqjL17yufvn9OVLyXYpvtyrFfak.jpg". */
export const POSTER_FILE = /^[\w-]{1,64}\.(jpg|jpeg|png|webp)$/;

/** TMDB's /3/search/movie answer, as suggestions: no adult films, nothing without a title. */
export function parseSearch(body: unknown): TmdbHit[] {
  const parsed = SearchAnswer.safeParse(body);
  if (!parsed.success) throw new TmdbError('BAD_RESPONSE', 'TMDB answered a search in an unexpected shape');
  return parsed.data.results
    .filter((r) => !r.adult && (r.title || r.original_title))
    .slice(0, SUGGEST_LIMIT)
    .map((r) => {
      const year = /^(\d{4})-/.exec(r.release_date ?? '')?.[1];
      const file = r.poster_path?.replace(/^\//, '') ?? '';
      return {
        tmdbId: r.id,
        title: (r.title || r.original_title) ?? '',
        originalTitle: (r.original_title || r.title) ?? '',
        year: year ? Number(year) : null,
        posterPath: POSTER_FILE.test(file) ? `/${file}` : null,
      };
    });
}

async function cached<T>(pool: Pool, key: string): Promise<{ value: T } | null> {
  const row = (
    await many<{ payload: { value: T } }>(
      pool,
      `select payload from provider_cache where provider = 'tmdb' and cache_key = $1 and expires_at > now()`,
      [key],
    )
  )[0];
  return row ? row.payload : null;
}

async function keep(pool: Pool, key: string, value: unknown, hours: number): Promise<void> {
  await pool.query(
    `insert into provider_cache (provider, cache_key, payload, expires_at)
     values ('tmdb', $1, $2, now() + make_interval(hours => $3))
     on conflict (provider, cache_key) do update set payload = excluded.payload, fetched_at = now(), expires_at = excluded.expires_at`,
    [key, { value }, hours],
  );
}

/** Films whose Chinese or original title matches what was typed; a day in the cache. Null without a key. */
export async function tmdbSuggest(env: TmdbEnv, typed: string): Promise<TmdbHit[] | null> {
  const key = await env.key();
  if (!key) return null;
  const q = typed.trim().toLowerCase();
  const ck = `suggest:${q}`;
  const hit = await cached<TmdbHit[]>(env.pool, ck);
  if (hit) return hit.value;
  let hits: TmdbHit[];
  try {
    hits = parseSearch(
      await tmdbGet(
        env.outbound,
        '/3/search/movie',
        { query: q, language: 'zh-TW', include_adult: 'false', page: '1' },
        key,
      ),
    );
  } catch (err) {
    if (err instanceof TmdbError) {
      await recordSourceHealth(env.pool, 'tmdb', err.code === 'INVALID_KEY' ? 'warn' : 'down', err.code, {});
      env.log.warn({ code: err.code }, 'TMDB search failed');
    }
    throw err;
  }
  await keep(env.pool, ck, hits, SUGGEST_HOURS);
  return hits;
}

const ExternalIds = z.object({ imdb_id: z.string().nullish() });

/** The IMDb code of a TMDB film (what YTS knows films by), or null when TMDB has none. A month in the cache. */
export async function tmdbImdbCode(env: TmdbEnv, tmdbId: number): Promise<string | null> {
  const key = await env.key();
  if (!key) return null;
  const ck = `imdb:${tmdbId}`;
  const hit = await cached<string | null>(env.pool, ck);
  if (hit) return hit.value;
  const body = await tmdbGet(env.outbound, `/3/movie/${tmdbId}/external_ids`, {}, key);
  const parsed = body === null ? null : ExternalIds.safeParse(body);
  if (parsed && !parsed.success)
    throw new TmdbError('BAD_RESPONSE', 'TMDB answered external ids in an unexpected shape');
  const imdb = parsed?.data.imdb_id ?? null;
  const code = imdb && /^tt\d{7,10}$/.test(imdb) ? imdb : null;
  await keep(env.pool, ck, code, code ? IMDB_DAYS * 24 : SUGGEST_HOURS);
  return code;
}

export const tmdbSmallPosterUrl = (file: string) => `https://${TMDB_IMAGE_HOST}/t/p/w92/${file}`;

/* ------------------------------------------------------------------ a film picked by hand */

/** Everything a film added by hand needs (Brian, 2026-10-09): it has no YTS page to say it. */
export type TmdbDetails = {
  tmdbId: number;
  /** The English title (what YTS would call it); the original one when TMDB has no English one. */
  title: string;
  titleZh: string | null;
  year: number;
  runtimeMin: number;
  /** English names, as YTS gives them (the pages translate them). */
  genres: string[];
  overview: string;
  overviewZh: string | null;
  posterPath: string | null;
  imdb: string | null;
  rating: number | null;
  language: string | null;
};

const Details = z.object({
  id: z.number(),
  title: z.string().nullish(),
  original_title: z.string().nullish(),
  original_language: z.string().nullish(),
  release_date: z.string().nullish(),
  runtime: z.number().nullish(),
  genres: z.array(z.object({ name: z.string() })).nullish(),
  overview: z.string().nullish(),
  poster_path: z.string().nullish(),
  vote_average: z.number().nullish(),
  vote_count: z.number().nullish(),
  imdb_id: z.string().nullish(),
  external_ids: z.object({ imdb_id: z.string().nullish() }).nullish(),
});

/** Two answers of /3/movie/<id>, in English and in zh-TW, as one film. */
export function parseDetails(en: unknown, zh: unknown): TmdbDetails {
  const e = Details.safeParse(en);
  const c = Details.safeParse(zh);
  if (!e.success || !c.success) throw new TmdbError('BAD_RESPONSE', 'TMDB answered a film in an unexpected shape');
  const m = e.data;
  const title = (m.title || m.original_title || '').trim();
  const zhTitle = c.data.title?.trim() || null;
  const year = Number(/^(\d{4})-/.exec(m.release_date ?? '')?.[1] ?? 0);
  const imdb = m.imdb_id ?? m.external_ids?.imdb_id ?? null;
  const file = m.poster_path?.replace(/^\//, '') ?? '';
  const votes = m.vote_count ?? 0;
  const original = [title, m.original_title ?? ''].map((s) => s.trim().toLowerCase());
  return {
    tmdbId: m.id,
    title: title.slice(0, 300),
    titleZh: zhTitle && !original.includes(zhTitle.toLowerCase()) ? zhTitle.slice(0, 300) : null,
    year,
    runtimeMin: Math.max(0, Math.round(m.runtime ?? 0)),
    genres: (m.genres ?? []).map((g) => g.name).slice(0, 10),
    overview: (m.overview ?? '').trim().slice(0, 4000),
    overviewZh: c.data.overview?.trim() ? c.data.overview.trim().slice(0, 4000) : null,
    posterPath: POSTER_FILE.test(file) ? `/${file}` : null,
    imdb: imdb && /^tt\d{7,10}$/.test(imdb) ? imdb : null,
    rating: votes >= MIN_VOTES && m.vote_average ? Math.round(m.vote_average * 10) / 10 : null,
    language: m.original_language ?? null,
  };
}

/** One film by its TMDB id, a week in the cache. Null without a key or when TMDB does not know it. */
export async function tmdbDetails(env: TmdbEnv, tmdbId: number): Promise<TmdbDetails | null> {
  const key = await env.key();
  if (!key) return null;
  const ck = `details:${tmdbId}`;
  const hit = await cached<TmdbDetails | null>(env.pool, ck);
  if (hit) return hit.value;
  const path = `/3/movie/${tmdbId}`;
  const [en, zh] = await Promise.all([
    tmdbGet(env.outbound, path, { language: 'en-US', append_to_response: 'external_ids' }, key),
    tmdbGet(env.outbound, path, { language: 'zh-TW' }, key),
  ]);
  const details = en === null || zh === null ? null : parseDetails(en, zh);
  await keep(env.pool, ck, details, details ? FILM_DAYS * 24 : UNKNOWN_HOURS);
  return details;
}

/** The w342 poster TMDB keeps for a film, as image bytes; null when there is none. */
export async function tmdbPosterImage(
  env: Pick<TmdbEnv, 'outbound'>,
  posterPath: string,
): Promise<{ body: Buffer; ext: 'jpg' | 'png' | 'webp' } | null> {
  const res = await outboundFetch(env.outbound, tmdbPosterUrl(posterPath), {
    allow: (h) => h === TMDB_IMAGE_HOST,
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 10_000,
  });
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim();
  const ext = type === 'image/jpeg' ? 'jpg' : type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : null;
  if (res.status !== 200 || !ext) return null;
  return { body: res.body, ext };
}
