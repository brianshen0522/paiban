import cookie from '@fastify/cookie';
import Fastify, { type FastifyInstance } from 'fastify';
import { authRoutes } from './auth/routes.js';
import { lookupSession, SESSION_COOKIE } from './auth/sessions.js';
import { eventRoutes } from './events/routes.js';
import type { Deps } from './http/context.js';
import { ApiError } from './http/errors.js';
import { libraryRoutes } from './library/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { settingsRoutes } from './settings/routes.js';
import { storageRoutes } from './storage/routes.js';
import { torrentRoutes } from './torrents/routes.js';
import { ytsRoutes } from './yts/routes.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The HTTP application. Separate from the entry point so tests can drive it with `inject`.
 * Caddy sits in front; the client address is taken from X-Forwarded-For only when the request
 * comes from a private network (the compose network).
 */
export function buildApp(deps: Deps): FastifyInstance {
  const app = Fastify({
    logger: false,
    trustProxy: ['127.0.0.0/8', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '::1'],
    bodyLimit: 1024 * 1024,
  });
  app.register(cookie);
  // A write without a body may still say application/json (docs/04-api.md: no Content-Type is
  // required then); treat an empty body as no body instead of failing.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = String(body);
    if (text.trim() === '') return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new ApiError('VALIDATION', 'body is not JSON', { fields: { _: 'NOT_JSON' } }), undefined);
    }
  });
  app.decorateRequest('user', null);

  const origin = new URL(deps.config.publicUrl).origin;
  app.addHook('onRequest', async (req) => {
    // Cross-site request protection (docs/12-auth.md, "防跨站請求").
    if (MUTATING.has(req.method) && req.url.startsWith('/api/')) {
      if (req.headers['x-requested-with'] !== 'paiban') throw new ApiError('FORBIDDEN', 'missing X-Requested-With');
      if (req.headers.origin !== origin) throw new ApiError('FORBIDDEN', 'cross-origin request');
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) {
      const row = await lookupSession(deps.pool, token);
      if (row) {
        req.user = {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          role: row.role,
          prefs: row.prefs,
          sessionId: row.session_id,
        };
      }
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.status(err.status).send(err.body());
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      const code = e.statusCode === 413 ? 'UPLOAD_TOO_LARGE' : e.statusCode === 415 ? 'UNSUPPORTED_FILE' : 'VALIDATION';
      const api = new ApiError(
        code,
        e.message ?? 'bad request',
        code === 'VALIDATION' ? { fields: { _: e.code ?? 'BAD_REQUEST' } } : undefined,
      );
      return reply.status(api.status).send(api.body());
    }
    deps.log.error({ err, method: req.method, url: req.url.split('?')[0] }, 'unexpected error');
    const api = new ApiError('INTERNAL', 'unexpected error');
    return reply.status(api.status).send(api.body());
  });
  app.setNotFoundHandler((_req, reply) => {
    const api = new ApiError('NOT_FOUND', 'no such endpoint');
    return reply.status(api.status).send(api.body());
  });

  app.get('/api/health', async () => {
    await deps.pool.query('select 1');
    return { ok: true };
  });

  authRoutes(app, deps);
  ytsRoutes(app, deps);
  torrentRoutes(app, deps);
  storageRoutes(app, deps);
  libraryRoutes(app, deps);
  notificationRoutes(app, deps);
  settingsRoutes(app, deps);
  eventRoutes(app, deps);
  return app;
}
