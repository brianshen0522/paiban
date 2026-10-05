import Fastify, { type FastifyInstance } from 'fastify';

/** Builds the HTTP application. Separate from the entry point so tests can use `inject`. */
export function buildApp(options: { logger: boolean } = { logger: false }): FastifyInstance {
  const app = Fastify({ logger: options.logger });
  app.get('/api/health', async () => ({ ok: true }));
  return app;
}
