import { useState } from 'react';
import { t } from '../copy/zh-TW';
import { posterColor } from '../lib/format';

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
  const [failed, setFailed] = useState(false);
  const cls = `poster${size === 'lg' ? ' lg' : size === 'sm' ? ' sm' : ''}`;
  if (!failed) {
    return (
      <div className={`${cls} has-img`} style={{ ['--p' as string]: posterColor(title) }}>
        <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
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

export function Thumb({ title, year }: { title: string; year: number }) {
  return (
    <div className="thumb" style={{ ['--p' as string]: posterColor(title) }} aria-hidden="true">
      {year}
    </div>
  );
}
