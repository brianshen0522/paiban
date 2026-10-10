import { afterEach, describe, expect, it } from 'vitest';
import { setLocale } from '../copy';
import { posterRegion, withRegion } from './Poster';

/** Which country's poster to ask for (Brian, 2026-10-10). */
describe('poster country', () => {
  afterEach(() => setLocale('zh-TW'));

  it('follows the interface language until the person chooses', () => {
    expect(posterRegion(null)).toBe('TW');
    setLocale('en');
    expect(posterRegion(null)).toBe('US');
    expect(posterRegion('JP')).toBe('JP');
  });

  it('adds the country to our poster endpoints only', () => {
    expect(withRegion('/api/yts/movies/12/poster', 'HK')).toBe('/api/yts/movies/12/poster?region=HK');
    expect(withRegion('/api/movies/0f8fad5b-d9cb-469f-a165-70867728950e/poster', 'KR')).toBe(
      '/api/movies/0f8fad5b-d9cb-469f-a165-70867728950e/poster?region=KR',
    );
    expect(withRegion('/api/tmdb/poster/a.png', 'JP')).toBe('/api/tmdb/poster/a.png');
  });
});
