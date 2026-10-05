import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['@paiban/source'] },
  test: { include: ['src/**/*.test.ts'] },
});
