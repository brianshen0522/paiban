import { defineConfig } from 'vitest/config';
import { workspaceAlias } from '../../vitest.shared.ts';

export default defineConfig({
  resolve: { alias: workspaceAlias },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Several files run real downloads, ffmpeg and timing checks: more at once than this starves
    // them on a modest machine and turns load into flaky failures.
    maxWorkers: 4,
  },
});
