import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

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
        const m = /^\/3\/find\/(tt\d+)$/.exec(path);
        if (isInception(m?.[1])) return send(200, tmdbFind);
        return send(200, '{"movie_results":[],"person_results":[],"tv_results":[]}');
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
    'yts-subs.com': `${base}/yify`,
    'subtitles.yts-subs.com': `${base}/yify-dl`,
    'api.assrt.net': `${base}/assrt`,
    'file.assrt.net': `${base}/assrt-file`,
  };
}
