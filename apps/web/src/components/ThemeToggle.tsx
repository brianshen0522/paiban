import { type ReactElement, useState } from 'react';
import { t } from '../copy';
import { setTheme, type ThemeChoice, useTheme } from '../lib/theme';

/** The order one press moves through. */
export const NEXT: Record<ThemeChoice, ThemeChoice> = { light: 'dark', dark: 'system', system: 'light' };

const ICONS: Record<ThemeChoice, ReactElement> = {
  light: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6" />
    </svg>
  ),
  dark: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
    </svg>
  ),
  system: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="12" rx="1.8" />
      <path d="M9 20h6M12 16.5V20" />
    </svg>
  ),
};

/**
 * Light, dark or the system's setting (Brian, 2026-10-06): one small button in a corner that
 * rolls to the next choice on each press. The label says what it is now and what a press does.
 */
export function ThemeToggle({ className = '' }: { className?: string }) {
  const current = useTheme();
  const [turns, setTurns] = useState(0);
  const next = NEXT[current];
  const label = t.theme.toggle(t.theme[current], t.theme[next]);
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      aria-label={label}
      title={label}
      onClick={() => {
        setTurns((n) => n + 1);
        setTheme(next);
      }}
    >
      <span className="theme-roll" style={{ transform: `rotate(${turns * 360}deg)` }}>
        {ICONS[current]}
      </span>
    </button>
  );
}
