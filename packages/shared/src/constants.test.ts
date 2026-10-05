import { describe, expect, it } from 'vitest';
import { PREVIEW_BYTES_PER_SECOND, SITE_NAME } from './index.js';

describe('constants', () => {
  it('has a site name', () => {
    expect(SITE_NAME.length).toBeGreaterThan(0);
  });

  it('reserves previews at the documented rates', () => {
    // docs/10-storage.md: 120 minutes at 480p reserves about 0.70 GB.
    const bytes = (PREVIEW_BYTES_PER_SECOND.audio + PREVIEW_BYTES_PER_SECOND['480p']) * 120 * 60;
    expect(bytes / 1024 ** 3).toBeCloseTo(0.7, 1);
  });
});
