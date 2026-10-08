import type { Me } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type Locale, locale, setLocale, t } from '../copy';
import { patch } from '../lib/api';
import { keys } from '../lib/queries';

/**
 * 中 / EN (Brian, 2026-10-08): one press switches the interface language. Signed in, the choice
 * is kept with the account (so it follows the person to another device); before signing in, on
 * this device only.
 */
export function LocaleToggle({ className = '' }: { className?: string }) {
  const qc = useQueryClient();
  const next: Locale = locale === 'en' ? 'zh-TW' : 'en';
  const label = t.locale.toggle(t.locale.names[next]);
  const press = () => {
    const me = qc.getQueryData<Me>(keys.me);
    // The account's choice first: the pages mount again on the switch and follow the account.
    if (me) qc.setQueryData<Me>(keys.me, { ...me, user: { ...me.user, prefs: { ...me.user.prefs, locale: next } } });
    setLocale(next);
    if (me)
      void patch('/api/me', { prefs: { locale: next } })
        .catch(() => undefined)
        .finally(() => qc.invalidateQueries({ queryKey: keys.me }));
  };
  return (
    <button
      type="button"
      className={`locale-toggle ${className}`.trim()}
      aria-label={label}
      title={label}
      onClick={press}
    >
      <span aria-hidden="true">{t.locale.short[next]}</span>
    </button>
  );
}
