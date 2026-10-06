import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SuggestInput } from './SuggestInput';

/** Chinese titles find nothing on YTS, so TMDB's films are offered while typing (Brian, 2026-10-06). */
const SUGGEST = {
  available: true,
  items: [
    { tmdbId: 900002, title: '謎中謎', originalTitle: 'Charade', year: 1963, posterUrl: '/api/tmdb/poster/a.jpg' },
    { tmdbId: 15, title: '大國民', originalTitle: 'Citizen Kane', year: 1941, posterUrl: null },
  ],
};

function answer(path: string): unknown {
  if (path.startsWith('/api/tmdb/suggest')) return SUGGEST;
  if (path === '/api/tmdb/900002/yts') return { ytsId: 2, imdbCode: 'tt9000002' };
  if (path === '/api/tmdb/15/yts') return { ytsId: null, imdbCode: 'tt0033467' };
  throw new Error(`unexpected ${path}`);
}

function Box() {
  const [q, setQ] = useState('');
  return (
    <form onSubmit={(e) => e.preventDefault()} data-testid="form">
      <SuggestInput value={q} onChange={setQ} placeholder="搜尋" label="搜尋電影" />
    </form>
  );
}

function setup() {
  const router = createMemoryRouter(
    [
      { path: '/', element: <Box /> },
      { path: '/movies/:id', element: <p>film page</p> },
    ],
    { initialEntries: ['/'] },
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return router;
}

describe('suggestions in the search box', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(JSON.stringify(answer(url)), { status: 200 })),
    );
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const typeIn = async (text: string) => {
    const box = screen.getByRole('combobox');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: text } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    return box;
  };

  it('offers TMDB films while typing a Chinese title, and opens the YTS film picked with the keys', async () => {
    const router = setup();
    const box = await typeIn('謎中');
    expect(await screen.findByRole('listbox')).toBeTruthy();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      expect.stringContaining('謎中謎'),
      expect.stringContaining('大國民'),
    ]);
    expect(box.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]?.id);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText('film page')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/movies/2');
  });

  it('says so when YTS does not have the picked film, and stays put', async () => {
    const router = setup();
    await typeIn('大國');
    fireEvent.click((await screen.findAllByRole('option'))[1] as HTMLElement);
    expect(await screen.findByText('YTS 上沒有這部片。')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/');
  });

  it('closes on Esc, and Enter without a highlighted film leaves the search to the form', async () => {
    setup();
    const box = await typeIn('謎中');
    await screen.findByRole('listbox');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    const submitted = vi.fn((e: Event) => e.preventDefault());
    screen.getByTestId('form').addEventListener('submit', submitted);
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.submit(screen.getByTestId('form'));
    expect(submitted).toHaveBeenCalled();
  });
});
