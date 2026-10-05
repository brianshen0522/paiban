import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
// Relative import: the config is loaded before workspace packages are built.
import { SITE_NAME } from '../../packages/shared/src/constants.ts';

export default defineConfig({
  plugins: [
    react(),
    // D9: the page title comes from the one constant, not from index.html.
    { name: 'site-name', transformIndexHtml: (html) => html.replaceAll('%SITE_NAME%', SITE_NAME) },
  ],
  resolve: { conditions: ['@paiban/source'] },
  server: { proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'jsdom', include: ['src/**/*.test.tsx'] },
});
