import { fileURLToPath } from 'node:url';

/**
 * Tests run against the workspace sources, never a stale dist/: workspace packages resolve to their
 * src/ entry points. (The `@paiban/source` export condition does the same for tsc and Vite builds.)
 */
export const workspaceAlias = {
  '@paiban/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
};
