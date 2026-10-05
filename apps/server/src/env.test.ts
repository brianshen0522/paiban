import { describe, expect, it } from 'vitest';
import { testOnlyVariablesInProduction } from './env.js';

describe('test-only variables', () => {
  it('are reported when set in production', () => {
    expect(
      testOnlyVariablesInProduction({ NODE_ENV: 'production', ALLOW_LOCAL_SOURCES: '1', TORRENT_TEST_PEERS: 'seed:1' }),
    ).toEqual(['ALLOW_LOCAL_SOURCES', 'TORRENT_TEST_PEERS']);
  });

  it('are allowed outside production', () => {
    expect(testOnlyVariablesInProduction({ NODE_ENV: 'test', SOURCE_OVERRIDES: '{}' })).toEqual([]);
  });

  it('count as unset when empty', () => {
    expect(testOnlyVariablesInProduction({ NODE_ENV: 'production', SOURCE_OVERRIDES: '' })).toEqual([]);
  });
});
