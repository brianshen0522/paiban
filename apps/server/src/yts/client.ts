import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { one } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { OutboundError, type OutboundPolicy, outboundFetch } from '../net/outbound.js';

/**
 * YTS, the only source of films and versions (docs/05-yts.md). The address is a setting; the
 * client never looks for a new domain and never follows a redirect to another host. Responses are
 * validated with zod and stored in provider_cache in our own shape, never raw.
 */

export type YtsTorrent = {
  hash: string;
  quality: string;
  type: string;
  videoCodec: string;
  bitDepth: number;
  audioChannels: string;
  sizeBytes: number;
  seeds: number;
  peers: number;
  uploadedAt: string | null;
};

export type YtsMovie = {
  ytsId: number;
  imdbCode: string;
  title: string;
  year: number;
  runtimeMin: number;
  rating: number;
  genres: string[];
  summary: string;
  language: string | null;
  coverUrl: string | null;
  torrents: YtsTorrent[];
};

export type YtsPage = { total: number; movies: YtsMovie[] };

const num = z.union([z.number(), z.string()]).transform((v) => Number(v));
const TorrentSchema = z.object({
  hash: z.string().regex(/^[0-9a-fA-F]{40}$/),
  size_bytes: num.pipe(z.number().positive()),
  quality: z.string().default(''),
  type: z.string().default(''),
  video_codec: z.string().default(''),
  bit_depth: z.union([z.string(), z.number()]).optional(),
  audio_channels: z.string().default(''),
  seeds: num.optional(),
  peers: num.optional(),
  date_uploaded_unix: num.optional(),
});
const MovieSchema = z.object({
  id: num.pipe(z.number().int().positive()),
  imdb_code: z.string().regex(/^tt\d+$/),
  title: z.string().min(1),
  year: num.pipe(z.number().int()),
  runtime: num.optional(),
  rating: num.optional(),
  genres: z.array(z.string()).optional(),
  summary: z.string().optional(),
  description_full: z.string().optional(),
  language: z.string().nullable().optional(),
  medium_cover_image: z.string().optional(),
  torrents: z.array(z.unknown()).optional(),
});
const Envelope = z.object({ status: z.string(), status_message: z.string().optional(), data: z.unknown() });

function toTorrent(raw: unknown): YtsTorrent | null {
  const r = TorrentSchema.safeParse(raw);
  if (!r.success) return null;
  const t = r.data;
  const bitDepth = Number(t.bit_depth ?? 8);
  return {
    hash: t.hash.toLowerCase(),
    quality: t.quality,
    type: t.type,
    videoCodec: t.video_codec,
    bitDepth: Number.isFinite(bitDepth) && bitDepth > 0 ? bitDepth : 8,
    audioChannels: t.audio_channels,
    sizeBytes: Math.round(t.size_bytes),
    seeds: Number.isFinite(t.seeds) ? (t.seeds as number) : 0,
    peers: Number.isFinite(t.peers) ? (t.peers as number) : 0,
    uploadedAt: t.date_uploaded_unix ? new Date(t.date_uploaded_unix * 1000).toISOString() : null,
  };
}

/** One movie object from YTS, or null when a required field is missing (it is then skipped). */
export function toMovie(raw: unknown): YtsMovie | null {
  const r = MovieSchema.safeParse(raw);
  if (!r.success) return null;
  const m = r.data;
  return {
    ytsId: m.id,
    imdbCode: m.imdb_code,
    title: m.title,
    year: m.year,
    runtimeMin: Number.isFinite(m.runtime) ? (m.runtime as number) : 0,
    rating: Number.isFinite(m.rating) ? (m.rating as number) : 0,
    genres: m.genres ?? [],
    summary: m.summary || m.description_full || '',
    language: m.language ?? null,
    coverUrl: m.medium_cover_image ?? null,
    torrents: (m.torrents ?? []).map(toTorrent).filter((t): t is YtsTorrent => t !== null),
  };
}

export function parseList(body: unknown): YtsPage {
  const env = Envelope.safeParse(body);
  if (!env.success || env.data.status !== 'ok') throw new ApiError('YTS_BAD_RESPONSE', 'not a YTS list answer');
  const data = z.object({ movie_count: num, movies: z.array(z.unknown()).optional() }).safeParse(env.data.data);
  if (!data.success) throw new ApiError('YTS_BAD_RESPONSE', 'list answer without movie_count');
  // No results: YTS leaves the `movies` key out instead of sending an empty array.
  return {
    total: data.data.movie_count,
    movies: (data.data.movies ?? []).map(toMovie).filter((m): m is YtsMovie => m !== null),
  };
}

export function parseDetail(body: unknown): YtsMovie | null {
  const env = Envelope.safeParse(body);
  if (!env.success || env.data.status !== 'ok') throw new ApiError('YTS_BAD_RESPONSE', 'not a YTS detail answer');
  const data = z.object({ movie: z.unknown() }).safeParse(env.data.data);
  if (!data.success) throw new ApiError('YTS_BAD_RESPONSE', 'detail answer without movie');
  return toMovie(data.data.movie);
}

export type SearchParams = {
  q?: string | undefined;
  quality?: string | undefined;
  genre?: string | undefined;
  minRating?: number | undefined;
  sort?: 'added' | 'rating' | 'year' | 'seeds' | undefined;
  page: number;
  limit: number;
};

const SORT: Record<NonNullable<SearchParams['sort']>, string> = {
  added: 'date_added',
  rating: 'rating',
  year: 'year',
  seeds: 'seeds',
};

/** At most four requests to YTS at a time (docs/05-yts.md, "請求的規矩"). */
let inFlight = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (inFlight >= 4) await new Promise<void>((r) => waiting.push(r));
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
    waiting.shift()?.();
  }
}

export class YtsClient {
  private readonly policy: OutboundPolicy;
  private readonly baseUrl: string;
  constructor(policy: OutboundPolicy, baseUrl: string) {
    this.policy = policy;
    this.baseUrl = baseUrl;
  }

  private get host(): string {
    return new URL(this.baseUrl).hostname;
  }

  /** GET + JSON with one retry on network errors and 5xx; everything else maps to an API error. */
  async getJson(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(path, `${this.baseUrl}/`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await slot(() =>
          outboundFetch(this.policy, url.toString(), {
            allow: (h) => h === this.host,
            sameHostRedirectsOnly: true,
            maxBytes: 5 * 1024 * 1024,
            timeoutMs: 10_000,
            headers: { Accept: 'application/json' },
          }),
        );
        if (res.status >= 500 && attempt === 0) continue;
        if (res.status >= 500) throw new ApiError('YTS_UNREACHABLE', `YTS answered ${res.status}`);
        try {
          return JSON.parse(res.body.toString('utf8'));
        } catch {
          throw new ApiError('YTS_BAD_RESPONSE', `YTS answered ${res.status} with something that is not JSON`);
        }
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (err instanceof OutboundError) {
          if (err.kind === 'REDIRECTED') throw new ApiError('YTS_UNREACHABLE', `YTS redirects to ${err.host}`);
          if ((err.kind === 'NETWORK' || err.kind === 'TIMEOUT') && attempt === 0) continue;
          if (err.kind === 'TOO_LARGE') throw new ApiError('YTS_BAD_RESPONSE', err.message);
          throw new ApiError('YTS_UNREACHABLE', err.message);
        }
        throw err;
      }
    }
  }

  async search(p: SearchParams): Promise<YtsPage> {
    const params: Record<string, string> = {
      limit: String(p.limit),
      page: String(p.page),
      order_by: 'desc',
      sort_by: SORT[p.sort ?? 'added'],
    };
    if (p.q) params.query_term = p.q;
    if (p.quality) params.quality = p.quality;
    if (p.genre) params.genre = p.genre;
    if (p.minRating) params.minimum_rating = String(p.minRating);
    return parseList(await this.getJson('api/v2/list_movies.json', params));
  }

  async movie(ytsId: number): Promise<YtsMovie | null> {
    return parseDetail(await this.getJson('api/v2/movie_details.json', { movie_id: String(ytsId) }));
  }
}

/* ------------------------------------------------------------------ cache */

export async function cacheGet<T>(
  q: Queryable,
  key: string,
  allowStale = false,
): Promise<{ value: T; fetchedAt: Date; fresh: boolean } | null> {
  const r = await one<{ payload: T; fetched_at: Date; fresh: boolean }>(
    q,
    `select payload, fetched_at, expires_at > now() as fresh from provider_cache where provider = 'yts' and cache_key = $1`,
    [key],
  );
  if (!r || (!r.fresh && !allowStale)) return null;
  return { value: r.payload, fetchedAt: r.fetched_at, fresh: r.fresh };
}

export async function cachePut(q: Queryable, key: string, value: unknown, minutes: number): Promise<Date> {
  const r = await one<{ fetched_at: Date }>(
    q,
    `insert into provider_cache (provider, cache_key, payload, fetched_at, expires_at)
     values ('yts', $1, $2::jsonb, now(), now() + make_interval(mins => $3))
     on conflict (provider, cache_key) do update set payload = excluded.payload, fetched_at = now(), expires_at = excluded.expires_at
     returning fetched_at`,
    [key, JSON.stringify(value), minutes],
  );
  return r?.fetched_at ?? new Date();
}
