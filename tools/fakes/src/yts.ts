import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { catalogue, type LocalVersion } from './films.ts';

/**
 * A small YTS: list_movies.json and movie_details.json in the real shape (docs/05-yts.md),
 * over the fake catalogue. `mode` makes it misbehave the ways the tests need.
 */
export type FakeYtsMode = 'ok' | 'error500' | 'html' | 'redirect';

export type FakeYts = {
  url: string;
  setMode(mode: FakeYtsMode): void;
  requests: string[];
  close(): Promise<void>;
};

export async function startFakeYts(
  opts: { port?: number; host?: string; local?: LocalVersion[]; publicUrl?: string } = {},
): Promise<FakeYts> {
  let mode: FakeYtsMode = 'ok';
  const requests: string[] = [];
  let base = opts.publicUrl ?? '';

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push(`${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (mode === 'error500') return json(500, { error: 'down' });
    if (mode === 'html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>Parked domain</title>');
    }
    if (mode === 'redirect') {
      res.writeHead(301, { Location: `https://yts.example${url.pathname}${url.search}` });
      return res.end();
    }
    const films = catalogue(base, opts.local ?? []);
    if (url.pathname === '/api/v2/list_movies.json') {
      const q = (url.searchParams.get('query_term') ?? '').toLowerCase();
      const quality = url.searchParams.get('quality');
      const genre = (url.searchParams.get('genre') ?? '').toLowerCase();
      const min = Number(url.searchParams.get('minimum_rating') ?? 0);
      const sort = url.searchParams.get('sort_by') ?? 'date_added';
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 20)));
      const page = Math.max(1, Number(url.searchParams.get('page') ?? 1));
      let list = films.filter(
        (f) =>
          (!q || f.title.toLowerCase().includes(q) || String(f.year) === q || f.imdb_code === q) &&
          (!quality || f.torrents.some((t) => t.quality === quality)) &&
          (!genre || f.genres.some((g) => g.toLowerCase() === genre)) &&
          f.rating >= min,
      );
      const key = (f: (typeof list)[number]) =>
        sort === 'rating'
          ? f.rating
          : sort === 'year'
            ? f.year
            : sort === 'seeds'
              ? Math.max(...f.torrents.map((t) => Number(t.seeds)))
              : f.date_uploaded_unix;
      list = [...list].sort((a, b) => key(b) - key(a));
      const slice = list.slice((page - 1) * limit, page * limit);
      // Like the real one: no `movies` key at all when there is nothing to list.
      const data: Record<string, unknown> = { movie_count: list.length, limit, page_number: page };
      if (slice.length) data.movies = slice;
      return json(200, { status: 'ok', status_message: 'Query was successful', data });
    }
    if (url.pathname === '/api/v2/movie_details.json') {
      const id = Number(url.searchParams.get('movie_id'));
      const film = films.find((f) => f.id === id);
      // The real YTS answers an unknown id with an empty movie object.
      return json(200, {
        status: 'ok',
        status_message: 'Query was successful',
        data: { movie: film ?? { id: 0, title: '', year: 0 } },
      });
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : (opts.host ?? '127.0.0.1')}:${port}`;
  base ||= url;
  return {
    url,
    setMode: (m) => {
      mode = m;
    },
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
