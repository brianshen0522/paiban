import { defineConfig } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
