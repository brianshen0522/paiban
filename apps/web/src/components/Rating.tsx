import type { MovieSummary } from '@paiban/shared';
import { t } from '../copy/zh-TW';

/** The rating with where it came from: TMDB's, or YTS's IMDb figure when TMDB has none (Brian, 2026-10-06). */
export function Rating({ m }: { m: Pick<MovieSummary, 'rating' | 'ratingSource'> }) {
  const source = t.rating[m.ratingSource];
  return (
    <span className="mono rating" title={t.rating.title(source)}>
      {source} ★ {m.rating.toFixed(1)}
    </span>
  );
}
