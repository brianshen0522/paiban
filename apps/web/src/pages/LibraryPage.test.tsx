import type { LibraryItem } from '@paiban/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/Toasts';
import { t } from '../copy';
import { LibraryPage } from './LibraryPage';

/** The site-wide library (Brian, 2026-10-09): everyone sees every finished film and joins with one press. */
const film = (id: string, mine: boolean): LibraryItem =>
  ({
    torrent: {
      id,
      movie: { ytsId: 1, title: 'Charade', titleZh: '謎中謎', year: 1963, runtimeMin: 113, posterUrl: '' },
      version: { quality: '1080p', source: 'bluray', videoCodec: 'x264', bitDepth: 8, audio: '2.0' },
      holders: [{ id: 'u-mei', displayName: '美玲' }],
      mine,
      media: null,
    },
    subtitles: { total: 2, confirmed: 2, draft: 0 },
    exports: 1,
    filmExports: { count: 1, bytes: 1 },
    next: 'exported',
    confirmedLanguages: ['en', 'zh-Hant'],
  }) as unknown as LibraryItem;

describe('the library page, all films', () => {
  let joined = false;
  const sent: string[] = [];
  beforeEach(() => {
    joined = false;
    sent.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/torrents/t1/hold') {
          joined = true;
          return new Response('{}', { status: 200 });
        }
        if (url === '/api/library?scope=all')
          return new Response(JSON.stringify([film('t1', joined)]), { status: 200 });
        return new Response('[]', { status: 200 });
      }),
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const mount = (path: string) => {
    const router = createMemoryRouter([{ path: '/library', element: <LibraryPage /> }], { initialEntries: [path] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <RouterProvider router={router} />
        </ToastProvider>
      </QueryClientProvider>,
    );
  };

  it('shows who holds it and its confirmed languages, joins with one press, then offers to open it', async () => {
    mount('/library?scope=all');
    expect(screen.getByRole('tab', { name: new RegExp(t.library.tabs.all) }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const join = await screen.findByRole('button', { name: t.library.join });
    expect(screen.getByText(t.library.heldBy('美玲'), { exact: false })).toBeTruthy();
    expect(screen.getByText(/已確認的字幕/).textContent).toContain('English');
    fireEvent.click(join);
    await screen.findByRole('link', { name: t.library.open });
    expect(sent).toContain('POST /api/torrents/t1/hold');
  });

  it('switches between the two lists with the tabs', async () => {
    mount('/library');
    await waitFor(() => expect(screen.getByText(t.library.empty)).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: new RegExp(t.library.tabs.all) }));
    await screen.findByRole('button', { name: t.library.join });
  });
});
