import { useSyncExternalStore } from 'react';

/**
 * Light, dark, or follow the system (Brian, 2026-10-06). A per-device choice kept in localStorage;
 * public/theme-init.js applies it before the first paint so there is no flash.
 */
export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'paiban.theme';
const listeners = new Set<() => void>();

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked: the choice still applies to this page
  }
  applyTheme(choice);
  for (const l of listeners) l();
}

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      const onStorage = (e: StorageEvent) => {
        if (e.key === KEY) {
          applyTheme(readTheme());
          cb();
        }
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
      };
    },
    readTheme,
    () => 'system',
  );
}
