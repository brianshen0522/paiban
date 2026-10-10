import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { TMDB_ONLY, tmdbCatalogue } from './films.ts';

/**
 * The fake subtitle sources (docs/15-testing.md, "假的字幕來源"): one HTTP server that answers for
 * JustSubtitles (and its title search), SubDL, TMDB, YIFY Subtitles and 射手網, with the responses
 * recorded in phase 0 (reference/providers) and fixtures/archive.zip as every download. The app
 * reaches it through SOURCE_OVERRIDES; `overrides(url)` gives that map.
 *
 * Only Inception (IMDb tt1375666, TMDB 27205) has results, like the recordings; any other film is
 * "not found" in each source's own way. `answerAsInception` lists other IMDb codes the sources
 * treat as Inception's, so a film the fake YTS offers (and the local seeder serves) has results too. `setMode` makes one source misbehave; `requests` records
 * what arrived and when, so tests can check pacing and that a source was never contacted.
 */
export type FakeSource =
  | 'justsubtitles'
  | 'justsubtitles-search'
  | 'subdl'
  | 'subdl-dl'
  | 'tmdb'
  | 'tmdb-img'
  | 'yify'
  | 'yify-dl'
  | 'assrt'
  | 'assrt-file';
export type FakeSourceMode =
  | 'ok'
  | 'error500'
  | 'html'
  | 'hang'
  | 'missing500'
  | 'ratelimit-once'
  | 'ratelimit'
  | 'nobutton';

export type FakeSources = {
  url: string;
  setMode(source: FakeSource, mode: FakeSourceMode): void;
  reset(): void;
  requests: { source: FakeSource; path: string; at: number; auth: string | null }[];
  /** SOURCE_OVERRIDES for this server: real host → fake base. */
  overrides: Record<string, string>;
  close(): Promise<void>;
};

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const recorded = (f: string) => readFileSync(repo(`reference/providers/${f}`), 'utf8');

/** A plain PNG of one colour, the size of a TMDB w342 poster: enough to see a poster arrive. */
function solidPng(hex: string, w = 342, h = 513): Buffer {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) row.set([r ?? 0, g ?? 0, b ?? 0], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = (crcTable[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const INCEPTION = { imdb: 'tt1375666', tmdb: 27205 } as const;

export async function startFakeSources(
  opts: { port?: number; host?: string; answerAsInception?: string[] } = {},
): Promise<FakeSources> {
  const isInception = (imdb: string | null | undefined) =>
    imdb === INCEPTION.imdb || (!!imdb && (opts.answerAsInception ?? []).includes(imdb));
  const modes = new Map<FakeSource, FakeSourceMode>();
  const requests: FakeSources['requests'] = [];
  const archive = readFileSync(repo('fixtures/archive.zip'));
  const srt = readFileSync(repo('fixtures/late.zh-TW.srt'));
  const jsZh = JSON.parse(recorded('justsubtitles.subtitles.sample.json'));
  const jsEn = recorded('justsubtitles.subtitles.en.sample.json');
  const jsMissing = recorded('justsubtitles.subtitles.missing.sample.json');
  const jsSearch = JSON.parse(recorded('justsubtitles.search.sample.json'));
  const tmdbFind = recorded('tmdb.find.sample.json');
  const tmdbFilms = [...tmdbCatalogue(), TMDB_ONLY];
  const yifyMovie = recorded('yify.movie-page.sample.html');
  const yifySub = recorded('yify.subtitle-page.sample.html');
  const assrtSearch = recorded('assrt.search.sample.json');
  // The hand-written detail points at an invalid host; the fake serves those files itself, on a
  // subdomain of assrt.net as the real API does.
  const assrtDetail = recorded('assrt.detail.sample.json').replaceAll(
    'https://file.example.invalid/',
    'https://file.assrt.net/',
  );
  const zhBg = JSON.stringify({
    status: true,
    subtitles: (jsZh.subtitles as { language: string }[])
      .slice(0, 2)
      .map((s) => ({ ...s, language: 'ZH_BG', lang: 'big_5_code' })),
  });

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const [, first, ...rest] = url.pathname.split('/');
    const source = first as FakeSource;
    const path = `/${rest.join('/')}`;
    const auth = (req.headers.authorization as string | undefined) ?? null;
    requests.push({ source, path: `${path}${url.search}`, at: Date.now(), auth });
    const mode = modes.get(source) ?? 'ok';
    const send = (status: number, body: string | Buffer, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(body);
    };
    if (mode === 'hang') return; // never answers: the client's timeout has to end it
    if (mode === 'error500') return send(500, '{"error":"down"}');
    if (mode === 'html')
      return send(200, '<!doctype html><title>Just a moment...</title><p>Checking your browser', 'text/html');

    switch (source) {
      case 'justsubtitles': {
        const m = /^\/api\/subtitles\/(\d+)$/.exec(path);
        if (!m) return send(404, '{}');
        const lang = url.searchParams.get('lang');
        if (Number(m[1]) !== INCEPTION.tmdb) return send(mode === 'missing500' ? 500 : 200, jsMissing);
        if (lang === 'EN') return send(200, jsEn);
        if (lang === 'ZH') return send(200, JSON.stringify(jsZh));
        if (lang === 'ZH_BG') return send(200, zhBg);
        return send(200, jsMissing);
      }
      case 'justsubtitles-search': {
        const q = (url.searchParams.get('q') ?? '').toLowerCase();
        return send(200, JSON.stringify(q.includes('inception') ? jsSearch : { results: [] }));
      }
      case 'tmdb': {
        const key = url.searchParams.get('api_key');
        if (!auth && !key) return send(401, '{"status_code":7,"status_message":"Invalid API key"}');
        if ((key ?? auth ?? '').includes('rejected')) return send(401, '{"status_code":7}');
        // GET /3/search/movie: the shape of TMDB's answer, matching the Chinese or the original title.
        if (path === '/3/search/movie') {
          const q = (url.searchParams.get('query') ?? '').trim().toLowerCase();
          const hits = q
            ? tmdbFilms.filter((f) => f.title.toLowerCase().includes(q) || f.originalTitle.toLowerCase().includes(q))
            : [];
          return send(
            200,
            JSON.stringify({
              page: 1,
              results: hits.map((f) => ({
                adult: false,
                id: f.tmdbId,
                title: f.title,
                original_title: f.originalTitle,
                original_language: 'en',
                overview: f.overview,
                poster_path: f.posterPath,
                release_date: `${f.year}-01-01`,
                popularity: f.voteCount / 100,
                vote_average: f.voteAverage,
                vote_count: f.voteCount,
              })),
              total_pages: 1,
              total_results: hits.length,
            }),
          );
        }
        // GET /3/movie/<id>/external_ids
        const ext = /^\/3\/movie\/(\d+)\/external_ids$/.exec(path);
        if (ext) {
          const film = tmdbFilms.find((f) => f.tmdbId === Number(ext[1]));
          return film
            ? send(200, JSON.stringify({ id: film.tmdbId, imdb_id: film.imdb, wikidata_id: null }))
            : send(
                404,
                '{"success":false,"status_code":34,"status_message":"The resource you requested could not be found."}',
              );
        }
        // GET /3/movie/<id>?language=…: a film picked by hand (the fake knows only the zh-TW title).
        const one = /^\/3\/movie\/(\d+)$/.exec(path);
        if (one) {
          const film = tmdbFilms.find((f) => f.tmdbId === Number(one[1]));
          if (!film)
            return send(
              404,
              '{"success":false,"status_code":34,"status_message":"The resource you requested could not be found."}',
            );
          const zh = (url.searchParams.get('language') ?? '').startsWith('zh');
          return send(
            200,
            JSON.stringify({
              id: film.tmdbId,
              title: zh ? film.title : film.originalTitle,
              original_title: film.originalTitle,
              original_language: 'en',
              release_date: `${film.year}-01-01`,
              runtime: 110,
              genres: [{ id: 18, name: zh ? '劇情' : 'Drama' }],
              overview: zh ? film.overview : `${film.originalTitle}: an English overview.`,
              // Japan has a poster of its own (a white one), for the poster-country preference.
              poster_path:
                url.searchParams.get('language') === 'ja-JP'
                  ? film.posterPath.replace(/\.png$/, '-ja.png')
                  : film.posterPath,
              vote_average: film.voteAverage,
              vote_count: film.voteCount,
              imdb_id: film.imdb,
              ...(url.searchParams.get('append_to_response') === 'external_ids'
                ? { external_ids: { imdb_id: film.imdb } }
                : {}),
            }),
          );
        }
        const m = /^\/3\/find\/(tt\d+)$/.exec(path);
        const film = tmdbFilms.find((f) => f.imdb === m?.[1]);
        // A film answered as Inception keeps Inception's TMDB id (the subtitle sources know only
        // that one) but its own title, overview and poster.
        if (isInception(m?.[1]) && !film) return send(200, tmdbFind);
        if (film)
          return send(
            200,
            JSON.stringify({
              movie_results: [
                {
                  id: isInception(film.imdb) ? INCEPTION.tmdb : film.tmdbId,
                  title: film.title,
                  original_title: film.originalTitle,
                  overview: film.overview,
                  poster_path: film.posterPath,
                  vote_average: film.voteAverage,
                  vote_count: film.voteCount,
                  media_type: 'movie',
                },
              ],
              person_results: [],
              tv_results: [],
            }),
          );
        return send(200, '{"movie_results":[],"person_results":[],"tv_results":[]}');
      }
      case 'tmdb-img': {
        const ja = tmdbFilms.find((f) => path.endsWith(f.posterPath.replace(/\.png$/, '-ja.png')));
        if (ja) return send(200, solidPng('#ffffff'), 'image/png');
        const film = tmdbFilms.find((f) => path.endsWith(f.posterPath));
        return film ? send(200, solidPng(film.color), 'image/png') : send(404, 'not found', 'text/plain');
      }
      case 'subdl': {
        const key = url.searchParams.get('api_key');
        if (!key) return send(200, '{"status":false,"error":"API key is required"}');
        if (key.includes('rejected')) return send(403, '{"status":false,"error":"Invalid API key"}');
        if (!isInception(url.searchParams.get('imdb_id')))
          return send(200, '{"status":false,"error":"can\'t find movie"}');
        return send(200, jsEn);
      }
      case 'subdl-dl':
      case 'yify-dl':
        return /\.zip$/.test(path) ? send(200, archive, 'application/zip') : send(404, '');
      case 'yify': {
        const m = /^\/movie-imdb\/(tt\d+)$/.exec(path);
        if (m) return isInception(m[1]) ? send(200, yifyMovie, 'text/html') : send(404, 'not found', 'text/html');
        if (path.startsWith('/subtitles/'))
          return send(
            200,
            mode === 'nobutton' ? yifySub.replace('btn-download-subtitle', 'btn-gone') : yifySub,
            'text/html',
          );
        return send(404, '', 'text/html');
      }
      case 'assrt': {
        if (!auth?.startsWith('Bearer ')) return send(200, '{"status":20001,"errmsg":"token invalid"}');
        if (auth.includes('rejected')) return send(200, '{"status":20001,"errmsg":"token invalid"}');
        if (mode === 'ratelimit' || mode === 'ratelimit-once') {
          if (mode === 'ratelimit-once') modes.set(source, 'ok');
          return send(200, '{"status":30900,"errmsg":"too many requests"}');
        }
        if (path === '/v1/user/quota')
          return send(200, '{"status":0,"user":{"action":"quota","result":"succeed","quota":17}}');
        if (path === '/v1/sub/search') {
          const q = (url.searchParams.get('q') ?? '').toLowerCase();
          return send(200, q.includes('sample') || q.includes('範例') ? assrtSearch : '{"status":0,"sub":{"subs":[]}}');
        }
        if (path === '/v1/sub/detail') return send(200, assrtDetail);
        return send(200, '{"status":20400,"errmsg":"no such endpoint"}');
      }
      case 'assrt-file':
        return send(200, srt, 'application/x-subrip');
      default:
        return send(404, '');
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://${opts.host === '0.0.0.0' || !opts.host ? '127.0.0.1' : opts.host}:${port}`;
  return {
    url,
    setMode: (source, mode) => {
      modes.set(source, mode);
    },
    reset: () => {
      modes.clear();
      requests.length = 0;
    },
    requests,
    overrides: fakeSourceOverrides(url),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** SOURCE_OVERRIDES for a fake at `base` (docs/15-testing.md lists the same hosts). */
export function fakeSourceOverrides(base: string): Record<string, string> {
  return {
    'www.justsubtitles.com': `${base}/justsubtitles`,
    'api.justsubtitles.com': `${base}/justsubtitles`,
    'search.justsubtitles.com': `${base}/justsubtitles-search`,
    'dl.subdl.com': `${base}/subdl-dl`,
    'api.subdl.com': `${base}/subdl`,
    'api.themoviedb.org': `${base}/tmdb`,
    'image.tmdb.org': `${base}/tmdb-img`,
    'yts-subs.com': `${base}/yify`,
    'subtitles.yts-subs.com': `${base}/yify-dl`,
    'api.assrt.net': `${base}/assrt`,
    'file.assrt.net': `${base}/assrt-file`,
  };
}
