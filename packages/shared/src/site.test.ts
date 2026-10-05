import { describe, expect, it } from 'vitest';
import { SITE_NAME } from './index.js';

describe('site name', () => {
  it('is a non-empty constant', () => {
    expect(SITE_NAME.length).toBeGreaterThan(0);
  });
});
