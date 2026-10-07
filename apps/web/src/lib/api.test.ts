import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiFailure, api } from './api';

/** What a failed request becomes on the page. */
describe('failed requests', () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, body: string, type = 'text/html') =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } })),
    );

  it('the proxy answering 502 while the server restarts reads as unreachable, not as an error of ours', async () => {
    answer(502, '<html>Bad Gateway</html>');
    await expect(api('POST', '/api/x', {})).rejects.toMatchObject({ code: 'NETWORK', status: 502 });
  });

  it('our own errors keep their code, even with a 5xx status', async () => {
    answer(500, JSON.stringify({ error: { code: 'INTERNAL', message: 'x' } }), 'application/json');
    const e = await api('GET', '/api/x').catch((x) => x);
    expect(e).toBeInstanceOf(ApiFailure);
    expect(e).toMatchObject({ code: 'INTERNAL', status: 500 });
  });
});
