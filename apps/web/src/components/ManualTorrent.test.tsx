import type { TorrentInspection } from '@paiban/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../copy';
import { ManualTorrentDialog } from './ManualTorrent';

/** Adding a torrent by hand (Brian, 2026-10-09): link → what downloads → which film → start. */
const HASH = 'a'.repeat(40);
const inspection = (over: Partial<TorrentInspection> = {}): TorrentInspection => ({
  id: 'i1',
  source: 'magnet',
  infoHash: HASH,
  state: 'ready',
  errorCode: null,
  name: 'Citizen.Kane.1941.1080p.BluRay.x264',
  file: { path: 'Citizen.Kane.1941.1080p.BluRay.x264/kane.mp4', sizeBytes: 2 * 1024 ** 3 },
  skippedFiles: 2,
  version: { quality: '1080p', source: 'bluray', videoCodec: 'x264', bitDepth: 8 },
  guess: { title: 'Citizen Kane', year: 1941 },
  existing: null,
  createdAt: '2026-10-09T00:00:00Z',
  ...over,
});

describe('the add-a-torrent window', () => {
  const sent: { method: string; url: string; body: unknown }[] = [];
  let polls = 0;
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  beforeEach(() => {
    sent.length = 0;
    polls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url === '/api/torrents/inspect') {
          const magnet = (JSON.parse(String(init?.body)) as { magnet: string }).magnet;
          if (!magnet.startsWith('magnet:'))
            return reply(422, { error: { code: 'TORRENT_INVALID', message: '', details: { reason: 'BAD_MAGNET' } } });
          return reply(201, inspection({ state: 'pending', name: null, file: null }));
        }
        if (url === '/api/torrents/inspect/i1') {
          polls++;
          return reply(200, polls > 1 ? inspection() : inspection({ state: 'pending', file: null }));
        }
        if (url.startsWith('/api/tmdb/suggest'))
          return reply(200, {
            available: true,
            items: [{ tmdbId: 15, title: '大國民', originalTitle: 'Citizen Kane', year: 1941, posterUrl: null }],
          });
        if (url === '/api/torrents/manual')
          return reply(201, {
            joined: false,
            torrent: {
              id: 't1',
              movie: {
                ytsId: null,
                title: 'Citizen Kane',
                titleZh: '大國民',
                year: 1941,
                runtimeMin: 119,
                posterUrl: '',
              },
              version: { quality: '1080p', source: 'bluray', videoCodec: 'x264', bitDepth: 8, audio: '' },
            },
          });
        return reply(404, { error: { code: 'NOT_FOUND', message: '' } });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const mount = () => {
    const onClose = vi.fn();
    const router = createMemoryRouter([{ path: '/', element: <ManualTorrentDialog onClose={onClose} /> }]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    return onClose;
  };

  it('reads a magnet link, waits for the swarm, picks the film on TMDB and starts', async () => {
    mount();
    const read = screen.getByRole('button', { name: t.manual.read }) as HTMLButtonElement;
    expect(read.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(t.manual.magnetLabel), { target: { value: `magnet:?xt=urn:btih:${HASH}` } });
    fireEvent.click(read);
    await screen.findByText(t.manual.fetching);
    // Ready on the second poll: the file and the film search, started from the name.
    await screen.findByText(
      'Citizen.Kane.1941.1080p.BluRay.x264/kane.mp4'.split('/').at(-1) ?? '',
      {},
      { timeout: 5000 },
    );
    expect(screen.getByText(t.manual.skipped(2), { exact: false })).toBeTruthy();
    expect((screen.getByLabelText(t.manual.filmLabel) as HTMLInputElement).value).toBe('Citizen Kane');
    const start = screen.getByRole('button', { name: t.manual.start }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: /大國民/ }, { timeout: 3000 }));
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    await screen.findByText(t.manual.done);
    expect(sent.find((s) => s.url === '/api/torrents/manual')?.body).toEqual({ inspectionId: 'i1', tmdbId: 15 });
  });

  it('says what is wrong with a link that is not a magnet', async () => {
    mount();
    fireEvent.change(screen.getByLabelText(t.manual.magnetLabel), { target: { value: 'https://example.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: t.manual.read }));
    expect((await screen.findByRole('alert')).textContent).toBe(t.manual.invalid.BAD_MAGNET);
  });

  it('switches to a .torrent file with the tabs or the arrow keys', () => {
    mount();
    const tab = screen.getByRole('tab', { name: t.manual.tabs.magnet });
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: t.manual.tabs.file }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: t.manual.pick })).toBeTruthy();
  });
});
