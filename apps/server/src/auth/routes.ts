import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { verifyPassword } from './password.js';
import { AttemptLimiter } from './ratelimit.js';
import { createSession, deleteSession, SESSION_COOKIE } from './sessions.js';
import { describeAgent } from './useragent.js';
import { buildMe } from './users.js';

const LoginBody = z.object({ username: z.string().min(1).max(64), password: z.string().min(1).max(200) });

export function authRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;
  const perUser = new AttemptLimiter(5, 15 * 60_000);
  const perIp = new AttemptLimiter(20, 15 * 60_000);
  const secure = config.publicUrl.startsWith('https://');

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const username = body.username.trim().toLowerCase();
    const ip = req.ip;
    const wait = Math.max(perUser.retryAfter(username), perIp.retryAfter(ip));
    if (wait > 0) throw new ApiError('RATE_LIMITED', 'too many sign-in attempts', { retryAfterSeconds: wait });
    perIp.record(ip);

    const row = await one<{
      id: string;
      username: string;
      display_name: string;
      role: 'admin' | 'member';
      prefs: Record<string, unknown>;
      password_hash: string;
      disabled: boolean;
    }>(pool, 'select id, username, display_name, role, prefs, password_hash, disabled from users where username = $1', [
      username,
    ]);
    const ok = await verifyPassword(row?.password_hash ?? null, body.password);
    if (!row || !ok) {
      perUser.record(username);
      throw new ApiError('INVALID_CREDENTIALS', 'wrong username or password');
    }
    // Only now, with the right password, may the answer say the account exists but is disabled.
    if (row.disabled) throw new ApiError('ACCOUNT_DISABLED', 'account disabled');
    perUser.clear(username);

    const ua = req.headers['user-agent'] ?? '';
    const token = await createSession(pool, row.id, ua, ip);
    reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: 30 * 86_400 });
    const user = {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      prefs: row.prefs,
    };
    await audit(pool, user, 'auth.login', describeAgent(ua) as Record<string, string>, ip);
    return buildMe(pool, user);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const user = requireUser(req);
    await deleteSession(pool, user.sessionId);
    await audit(pool, user, 'auth.logout', {}, req.ip);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/api/auth/me', async (req) => buildMe(pool, requireUser(req)));
}
