import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeYts, startFakeYts } from './yts.ts';

let yts: FakeYts;
beforeAll(async () => {
  yts = await startFakeYts();
});
afterAll(() => yts.close());

describe('fake YTS', () => {
  it('answers in the real shape, leaving `movies` out when empty', async () => {
    type List = { data: { movie_count: number; movies: { torrents: { hash: string }[] }[] } };
    const all = (await (await fetch(`${yts.url}/api/v2/list_movies.json?limit=50`)).json()) as List;
    expect(all.data.movie_count).toBe(14);
    expect(all.data.movies[0].torrents[0].hash).toMatch(/^[0-9A-F]{40}$/);
    const none = (await (await fetch(`${yts.url}/api/v2/list_movies.json?query_term=zzz`)).json()) as List;
    expect(none.data).not.toHaveProperty('movies');
  });
});
