import type { Me } from '@paiban/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initialLocale, locale, setLocale, t } from '../copy';
import { keys } from '../lib/queries';
import { LocaleToggle } from './LocaleToggle';

/** 中 / EN in the top bar and on the sign-in pages (Brian, 2026-10-08). */
describe('the interface language button', () => {
  beforeEach(() => setLocale('zh-TW'));
  afterEach(() => {
    cleanup();
    setLocale('zh-TW');
    vi.unstubAllGlobals();
  });

  const mount = (qc = new QueryClient()) =>
    render(
      <QueryClientProvider client={qc}>
        <LocaleToggle />
      </QueryClientProvider>,
    );

  it('switches before signing in, on this device only', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    mount();
    const button = screen.getByRole('button');
    expect(button.textContent).toBe('EN');
    expect(button.getAttribute('aria-label')).toBe(t.locale.toggle('English'));
    fireEvent.click(button);
    expect(locale).toBe('en');
    expect(t.locale.follow).toBe('Follow the browser');
    expect(document.documentElement.lang).toBe('en');
    expect(localStorage.getItem('paiban.locale')).toBe('en');
    expect(initialLocale()).toBe('en');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the choice with the account when signed in, and in the cached account at once', () => {
    const fetchSpy = vi.fn(
      async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const qc = new QueryClient();
    const me = { user: { id: 'u', prefs: { locale: null } } } as unknown as Me;
    qc.setQueryData(keys.me, me);
    mount(qc);
    fireEvent.click(screen.getByRole('button'));
    expect(qc.getQueryData<Me>(keys.me)?.user.prefs.locale).toBe('en');
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/me');
    expect(JSON.parse(String(init.body))).toEqual({ prefs: { locale: 'en' } });
  });
});
