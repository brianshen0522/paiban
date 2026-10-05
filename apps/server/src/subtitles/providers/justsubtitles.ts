import type { DetectedLang, Lang, SourceCheck } from '@paiban/shared';
import { z } from 'zod';
import { one } from '../../db/pool.js';
import {
  asJson,
  check,
  type Download,
  type FilmContext,
  type FoundSubtitle,
  failureCheck,
  hostList,
  type ProviderEnv,
  ProviderFailure,
  pathOnly,
  request,
  type SubtitleProvider,
  wanted,
} from './common.js';

/**
 * JustSubtitles (docs/07-subtitle-providers.md, "JustSubtitles"): the JSON its own site uses, by
 * TMDB id, one language per request; or, when an administrator switched the mode, SubDL's
 * official API with the same entries. Downloads come from dl.subdl.com and need nothing.
 */
export const JUSTSUBTITLES_HOSTS = hostList(
  'www.justsubtitles.com',
  'api.justsubtitles.com',
  'search.justsubtitles.com',
  'api.subdl.com',
  'dl.subdl.com',
);
const TMDB_HOSTS = hostList('api.themoviedb.org');

const Entry = z.object({
  release_name: z.string().nullish(),
  name: z.string().nullish(),
  lang: z.string().nullish(),
  language: z.string().nullish(),
  author: z.string().nullish(),
  url: z.string(),
  subtitlePage: z.string().nullish(),
  hi: z.boolean().nullish(),
});
const Answer = z.object({ status: z.boolean(), subtitles: z.array(z.unknown()).optional() });

const GUESS: Record<string, DetectedLang> = { EN: 'en', ZH_BG: 'zh-Hant', ZH: 'zh-Hans' };
const DOWNLOAD_PATH = /^\/subtitle\/\d+-\d+\.zip$/;

/**
 * One entry list, shared by both modes. The `url` keeps its path only: entries in the Chinese
 * categories carry somebody else's `api_key` in the query string, and it is dropped right here (D28).
 * Entries whose path is not `/subtitle/<n>-<n>.zip` are skipped.
 */
export function parseJustSubtitlesEntries(list: unknown[]): FoundSubtitle[] {
  const out: FoundSubtitle[] = [];
  for (const raw of list) {
    const e = Entry.safeParse(raw);
    if (!e.success) continue;
    const path = pathOnly(e.data.url);
    if (!DOWNLOAD_PATH.test(path)) continue;
    const code = (e.data.language ?? '').toUpperCase();
    const page = e.data.subtitlePage ? pathOnly(e.data.subtitlePage) : '';
    out.push({
      ref: path,
      languageLabel: e.data.lang ?? code,
      language: GUESS[code] ?? 'und',
      releaseName: e.data.release_name || e.data.name || '',
      uploader: e.data.author || null,
      pageUrl: page ? `https://www.justsubtitles.com${page}` : null,
      hearingImpaired: !!e.data.hi,
      rating: null,
      downloadUrl: `https://dl.subdl.com${path}`,
      ass: false,
    });
  }
  return out;
}

/**
 * The body of one `GET /api/subtitles/<tmdb>?lang=…`. `{status: false}` is "nothing for this id",
 * whether it came with 200 or 500: judged by the content, not the status code.
 */
export function parseJustSubtitlesAnswer(status: number, body: unknown): FoundSubtitle[] {
  const a = Answer.safeParse(body);
  if (!a.success) throw new ProviderFailure('BAD_RESPONSE', 'not the subtitles answer');
  if (!a.data.status) return [];
  if (status !== 200) throw new ProviderFailure('UNREACHABLE', `answered ${status}`);
  return parseJustSubtitlesEntries(a.data.subtitles ?? []);
}

/** Which `lang` values to ask for: Traditional asks both Chinese categories (docs/07, "語言對照"). */
export function justSubtitlesLangs(languages: readonly Lang[]): string[] {
  const out = new Set<string>();
  if (languages.includes('en')) out.add('EN');
  if (languages.includes('zh-Hant')) {
    out.add('ZH_BG');
    out.add('ZH');
  }
  if (languages.includes('zh-Hans')) out.add('ZH');
  return [...out];
}

/** TMDB "search movie" results from JustSubtitles' title search: the id only on one exact title-and-year match (D38). */
export function pickTitleMatch(body: unknown, title: string, year: number): number | null {
  const r = z
    .object({
      results: z.array(
        z.object({
          id: z.number(),
          title: z.string().nullish(),
          original_title: z.string().nullish(),
          release_date: z.string().nullish(),
        }),
      ),
    })
    .safeParse(body);
  if (!r.success) throw new ProviderFailure('BAD_RESPONSE', 'not the search answer');
  const want = title.trim().toLowerCase();
  const hits = r.data.results.filter(
    (m) =>
      (m.title?.trim().toLowerCase() === want || m.original_title?.trim().toLowerCase() === want) &&
      Number((m.release_date ?? '').slice(0, 4)) === year,
  );
  return hits.length === 1 ? (hits[0] as { id: number }).id : null;
}

/** TMDB find: the first movie's id, and its zh-TW title when it differs from the original. */
export function parseTmdbFind(body: unknown, originalTitle: string): { id: number; titleZh: string | null } | null {
  const r = z
    .object({ movie_results: z.array(z.object({ id: z.number(), title: z.string().nullish() })) })
    .safeParse(body);
  if (!r.success) throw new ProviderFailure('BAD_RESPONSE', 'not the find answer');
  const m = r.data.movie_results[0];
  if (!m) return null;
  const zh = m.title?.trim() || null;
  return { id: m.id, titleZh: zh && zh !== originalTitle ? zh : null };
}

/** A v4 read token is long and has two dots (a JWT); anything else is a v3 key that goes in the query. */
const isV4Token = (key: string) => key.length > 60 && key.split('.').length === 3;

async function tmdbFind(env: ProviderEnv, imdb: string, key: string): Promise<unknown> {
  const v4 = isV4Token(key);
  const url = `https://api.themoviedb.org/3/find/${encodeURIComponent(imdb)}?external_source=imdb_id&language=zh-TW${
    v4 ? '' : `&api_key=${encodeURIComponent(key)}`
  }`;
  const res = await request(env, url, {
    allow: TMDB_HOSTS,
    ...(v4 ? { headers: { Authorization: `Bearer ${key}` } } : {}),
  });
  if (res.status === 401) throw new ProviderFailure('NOT_CONFIGURED', 'TMDB refused the key', { invalidKey: true });
  if (res.status !== 200) throw new ProviderFailure('UNREACHABLE', `TMDB answered ${res.status}`);
  return asJson(res);
}

const TMDB_CACHE_DAYS = 30;

/**
 * IMDb id → TMDB id (docs/07, "把 IMDb 編號換成 TMDB 編號"): the film row, then TMDB with a key
 * (also keeping the zh-TW title), then JustSubtitles' own title search. NOT_CONFIGURED when none
 * of them gives an answer.
 */
export async function tmdbIdFor(env: ProviderEnv, film: FilmContext): Promise<number> {
  if (film.tmdbId) return film.tmdbId;
  const cached = await one<{ payload: { id: number } }>(
    env.pool,
    `select payload from provider_cache where provider = 'tmdb' and cache_key = $1 and expires_at > now()`,
    [`find:${film.imdbCode}`],
  );
  let id = cached?.payload.id ?? null;
  let titleZh: string | null = null;
  if (!id) {
    const key = await env.secret('tmdbKey');
    if (key) {
      const found = parseTmdbFind(await tmdbFind(env, film.imdbCode, key), film.title);
      id = found?.id ?? null;
      titleZh = found?.titleZh ?? null;
    } else {
      const res = await request(
        env,
        `https://search.justsubtitles.com/api/search?q=${encodeURIComponent(film.title)}`,
        { allow: JUSTSUBTITLES_HOSTS, pace: 'justsubtitles' },
      );
      if (res.status !== 200) throw new ProviderFailure('UNREACHABLE', `title search answered ${res.status}`);
      id = pickTitleMatch(asJson(res), film.title, film.year);
    }
    if (id)
      await env.pool.query(
        `insert into provider_cache (provider, cache_key, payload, expires_at) values ('tmdb', $1, $2, now() + make_interval(days => $3))
         on conflict (provider, cache_key) do update set payload = excluded.payload, fetched_at = now(), expires_at = excluded.expires_at`,
        [`find:${film.imdbCode}`, { id }, TMDB_CACHE_DAYS],
      );
  }
  if (!id) throw new ProviderFailure('NOT_CONFIGURED', 'no TMDB id for this film');
  await env.pool.query(
    'update movies set tmdb_id = $2, title_zh = coalesce($3, title_zh) where imdb_code = $1 and (tmdb_id is null or $3::text is not null)',
    [film.imdbCode, id, titleZh],
  );
  return id;
}

export class JustSubtitles implements SubtitleProvider {
  readonly id = 'justsubtitles' as const;
  private readonly env: ProviderEnv;
  private readonly mode: 'direct' | 'subdl';
  constructor(env: ProviderEnv, mode: 'direct' | 'subdl') {
    this.env = env;
    this.mode = mode;
  }

  allow(host: string): boolean {
    return JUSTSUBTITLES_HOSTS(host);
  }

  async search(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]> {
    if (this.mode === 'subdl') return this.searchSubdl(film, languages);
    const tmdb = await tmdbIdFor(this.env, film);
    const seen = new Set<string>();
    const out: FoundSubtitle[] = [];
    for (const lang of justSubtitlesLangs(languages)) {
      const res = await request(this.env, `https://www.justsubtitles.com/api/subtitles/${tmdb}?lang=${lang}`, {
        allow: JUSTSUBTITLES_HOSTS,
        pace: 'justsubtitles',
      });
      for (const f of parseJustSubtitlesAnswer(res.status, asJson(res)))
        if (!seen.has(f.ref)) {
          seen.add(f.ref);
          out.push(f);
        }
    }
    return out;
  }

  private async searchSubdl(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]> {
    const key = await this.env.secret('subdlKey');
    if (!key) throw new ProviderFailure('NOT_CONFIGURED', 'no SubDL key');
    const langs = justSubtitlesLangs(languages).join(',');
    // The key has to be in the query here; the shared client logs host and path only.
    const res = await request(
      this.env,
      `https://api.subdl.com/api/v1/subtitles?api_key=${encodeURIComponent(key)}&imdb_id=${encodeURIComponent(film.imdbCode)}&type=movie&languages=${langs}&subs_per_page=30`,
      { allow: JUSTSUBTITLES_HOSTS, pace: 'justsubtitles' },
    );
    return parseSubdlAnswer(res.status, asJson(res)).filter((f) => wanted(languages, f.language));
  }

  async resolveDownload(found: { ref: string }): Promise<Download[]> {
    if (!DOWNLOAD_PATH.test(found.ref)) return [];
    return [{ url: `https://dl.subdl.com${found.ref}`, fileName: found.ref.split('/').pop() as string }];
  }

  /** `POST /api/admin/sources/justsubtitles/test`: TMDB 27205 in English through the direct interface. */
  async test(): Promise<SourceCheck> {
    const started = Date.now();
    try {
      const res = await request(this.env, 'https://www.justsubtitles.com/api/subtitles/27205?lang=EN', {
        allow: JUSTSUBTITLES_HOSTS,
        pace: 'justsubtitles',
      });
      const found = parseJustSubtitlesAnswer(res.status, asJson(res));
      return check(started, true, 'OK', { status: res.status, count: found.length });
    } catch (err) {
      return failureCheck(started, err);
    }
  }

  /** `…/subdl/test`: the official API for tt1375666. */
  async testSubdl(): Promise<SourceCheck> {
    const started = Date.now();
    try {
      const found = await this.searchSubdl(
        {
          imdbCode: 'tt1375666',
          tmdbId: null,
          title: 'Inception',
          titleZh: null,
          year: 2010,
          release: { quality: '', source: '', videoCodec: '' },
        },
        ['en'],
      );
      return check(started, true, 'OK', { count: found.length });
    } catch (err) {
      return failureCheck(started, err);
    }
  }
}

/** SubDL's official answer: same entries; a refused key or used-up quota are their own codes. */
export function parseSubdlAnswer(status: number, body: unknown): FoundSubtitle[] {
  if (status === 401 || status === 403)
    throw new ProviderFailure('NOT_CONFIGURED', 'SubDL refused the key', { invalidKey: true });
  if (status === 429) throw new ProviderFailure('RATE_LIMITED', 'SubDL quota used up');
  const a = z
    .object({ status: z.boolean(), subtitles: z.array(z.unknown()).optional(), error: z.string().optional() })
    .safeParse(body);
  if (!a.success) throw new ProviderFailure('BAD_RESPONSE', 'not the SubDL answer');
  if (!a.data.status) {
    const e = (a.data.error ?? '').toLowerCase();
    if (/api.?key/.test(e)) throw new ProviderFailure('NOT_CONFIGURED', 'SubDL refused the key', { invalidKey: true });
    if (/limit|quota/.test(e)) throw new ProviderFailure('RATE_LIMITED', 'SubDL quota used up');
    return [];
  }
  if (status !== 200) throw new ProviderFailure('UNREACHABLE', `SubDL answered ${status}`);
  return parseJustSubtitlesEntries(a.data.subtitles ?? []);
}

/** `…/tmdb/test`: find tt1375666. */
export async function testTmdb(env: ProviderEnv): Promise<SourceCheck> {
  const started = Date.now();
  const key = await env.secret('tmdbKey');
  if (!key) return check(started, false, 'NOT_CONFIGURED');
  try {
    const found = parseTmdbFind(await tmdbFind(env, 'tt1375666', key), 'Inception');
    return check(started, true, 'OK', { count: found ? 1 : 0 });
  } catch (err) {
    return failureCheck(started, err);
  }
}
