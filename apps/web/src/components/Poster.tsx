import type { PosterRegion } from '@paiban/shared';
import { useState } from 'react';
import { locale, t } from '../copy';
import { posterColor } from '../lib/format';
import { useMe } from '../lib/queries';

/** The poster country: the person's choice, else the interface language's (Brian, 2026-10-10). */
export function posterRegion(chosen: PosterRegion | null | undefined): PosterRegion {
  return chosen ?? (locale === 'en' ? 'US' : 'TW');
}

/** Our poster endpoints take the country; other addresses are left as they are. */
export function withRegion(url: string, region: PosterRegion): string {
  if (!/^\/api\/(yts\/movies\/\d+|movies\/[0-9a-f-]{36})\/poster$/.test(url)) return url;
  return `${url}?region=${region}`;
}

/**
 * Poster through our own server (D30). Without an image, the flat typographic one-sheet from the
 * prototype: a stable colour from the title, the title in Oswald, year and runtime below.
 */
export function Poster({
  url,
  title,
  year,
  runtimeMin,
  size = 'card',
}: {
  url: string;
  title: string;
  year: number;
  runtimeMin: number;
  size?: 'card' | 'lg' | 'sm';
}) {
  const region = posterRegion(useMe().data?.user?.prefs.posterRegion);
  const src = withRegion(url, region);
  // A failure belongs to one address: another country's poster gets its own try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const failed = failedSrc === src;
  const cls = `poster${size === 'lg' ? ' lg' : size === 'sm' ? ' sm' : ''}`;
  if (!failed) {
    return (
      <div className={`${cls} has-img`} style={{ ['--p' as string]: posterColor(title) }}>
        <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailedSrc(src)} />
      </div>
    );
  }
  return (
    <div className={cls} style={{ ['--p' as string]: posterColor(title) }} aria-hidden="true">
      <b>{title}</b>
      <span>
        {year}
        {runtimeMin > 0 ? ` · ${t.search.minutes(runtimeMin)}` : ''}
      </span>
    </div>
  );
}
