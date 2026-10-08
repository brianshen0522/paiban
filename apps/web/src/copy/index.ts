import { en } from './en';
import { type Copy, zhTW } from './zh-TW';

/**
 * The interface language (Brian, 2026-10-08): Traditional Chinese or English, each person's own
 * choice (stored with their account), the browser's language until they choose. `t` is the copy
 * in use; it is a live binding, so the whole app is mounted again after `setLocale` (see App).
 */
export type Locale = 'zh-TW' | 'en';
export const LOCALES: readonly Locale[] = ['zh-TW', 'en'];

export type { Copy };
export let t: Copy = zhTW;
export let locale: Locale = 'zh-TW';

const KEY = 'paiban.locale';

/**
 * One section of the copy that always reads the language in use, for modules that keep a short
 * name for it (`const s = live('system')`): a plain `t.system` taken at load would stay in the
 * language the page started in.
 */
export function live<K extends keyof Copy>(section: K): Copy[K] {
  return new Proxy({} as Copy[K], { get: (_target, key) => Reflect.get(t[section], key) });
}

/** For Intl and toLocaleString: dates, numbers, language names. */
export const intlLocale = (): string => (locale === 'en' ? 'en' : 'zh-TW');

export function isLocale(v: unknown): v is Locale {
  return v === 'zh-TW' || v === 'en';
}

/** The last choice on this device, else the browser's languages: Chinese of any kind reads Traditional, else English. */
export function initialLocale(): Locale {
  try {
    const kept = localStorage.getItem(KEY);
    if (isLocale(kept)) return kept;
  } catch {
    // storage blocked: fall through to the browser
  }
  const langs = typeof navigator !== 'undefined' ? (navigator.languages ?? [navigator.language]) : [];
  for (const l of langs) {
    const x = l.toLowerCase();
    if (x.startsWith('zh')) return 'zh-TW';
    if (x.startsWith('en')) return 'en';
  }
  return 'zh-TW';
}

const listeners = new Set<(l: Locale) => void>();

/** Tells `listener` about every change of language; returns how to stop. */
export function onLocale(listener: (l: Locale) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Forgets this device's choice: back to the browser's language (the account's "follow the browser"). */
export function browserLocale(): Locale {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing kept
  }
  return initialLocale();
}

export function setLocale(next: Locale): void {
  const changed = next !== locale;
  locale = next;
  t = next === 'en' ? en : zhTW;
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'en' ? 'en' : 'zh-Hant-TW';
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // a private window: the choice still holds for this visit
  }
  if (changed) for (const l of listeners) l(next);
}
