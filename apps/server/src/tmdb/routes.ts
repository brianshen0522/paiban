import type { TmdbSuggestion } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { OutboundError, outboundFetch } from '../net/outbound.js';
import { readSettings } from '../settings/settings.js';
import { cacheGet, cachePut } from '../yts/client.js';
import { tmdbEnv, tracked, ytsClient } from '../yts/routes.js';
import { POSTER_FILE, TMDB_IMAGE_HOST, TmdbError, tmdbImdbCode, tmdbSmallPosterUrl, tmdbSuggest } from './tmdb.js';

/**
 * Searching by a Chinese title (Brian, 2026-10-06): YTS only understands English titles, so while
 * someone types, TMDB (which knows zh-TW titles) offers films; picking one finds its IMDb code on
 * TMDB and that code on YTS. Everything goes through this server; posters too (D30).
 */
const Suggest = z.object({ q: z.string().trim().min(1).max(100) });
const TmdbId = z.object({ tmdbId: z.coerce.number().int().positive().max(100_000_000) });
const Poster = z.object({ file: z.string().regex(POSTER_FILE) });
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
/** How long "this IMDb code is (not) on YTS" is kept: YTS adds films, so not long. */
const YTS_MINUTES = 60;

export function tmdbRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/tmdb/suggest', async (req): Promise<{ items: TmdbSuggestion[]; available: boolean }> => {
    requireUser(req);
    const { q } = parse(Suggest, req.query);
    let hits: Awaited<ReturnType<typeof tmdbSuggest>>;
    try {
      hits = await tmdbSuggest(tmdbEnv(deps), q);
    } catch (err) {
      // A suggestion box that fails says nothing; searching YTS by the English title still works.
      if (err instanceof TmdbError) return { items: [], available: false };
      throw err;
    }
    if (hits === null) return { items: [], available: false };
    return {
      available: true,
      items: hits.map((h) => ({
        tmdbId: h.tmdbId,
        title: h.title,
        originalTitle: h.originalTitle,
        year: h.year,
        posterUrl: h.posterPath ? `/api/tmdb/poster/${h.posterPath.slice(1)}` : null,
      })),
    };
  });

  app.get('/api/tmdb/:tmdbId/yts', async (req): Promise<{ ytsId: number | null; imdbCode: string | null }> => {
    requireUser(req);
    const { tmdbId } = parse(TmdbId, req.params);
    let imdb: string | null;
    try {
      imdb = await tmdbImdbCode(tmdbEnv(deps), tmdbId);
    } catch (err) {
      if (err instanceof TmdbError) throw new ApiError('INTERNAL', `TMDB: ${err.code}`);
      throw err;
    }
    if (!imdb) return { ytsId: null, imdbCode: null };
    const host = new URL((await readSettings(deps.pool)).yts.baseUrl || 'http://unset').host;
    const key = `imdb:${host}:${imdb}`;
    const kept = await cacheGet<{ ytsId: number | null }>(deps.pool, key);
    if (kept) return { ytsId: kept.value.ytsId, imdbCode: imdb };
    const client = await ytsClient(deps);
    // YTS's query_term matches IMDb codes as well as titles.
    const page = await tracked(deps, () => client.search({ q: imdb, page: 1, limit: 5 }));
    const ytsId = page.movies.find((m) => m.imdbCode === imdb)?.ytsId ?? null;
    await cachePut(deps.pool, key, { ytsId }, YTS_MINUTES);
    return { ytsId, imdbCode: imdb };
  });

  app.get('/api/tmdb/poster/:file', async (req, reply) => {
    requireUser(req);
    const { file } = parse(Poster, req.params);
    try {
      const res = await outboundFetch(deps.outbound, tmdbSmallPosterUrl(file), {
        allow: (h) => h === TMDB_IMAGE_HOST,
        maxBytes: 512 * 1024,
        timeoutMs: 8_000,
      });
      const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
      if (res.status !== 200 || !IMAGE_TYPES.includes(type)) throw new ApiError('NOT_FOUND', 'no poster');
      reply.header('Cache-Control', 'private, max-age=604800').type(type);
      return reply.send(res.body);
    } catch (err) {
      if (err instanceof OutboundError) throw new ApiError('NOT_FOUND', 'no poster');
      throw err;
    }
  });
}
