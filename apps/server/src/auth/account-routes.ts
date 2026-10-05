import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Me, Session, User } from '@paiban/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, pgCode, tx, UNIQUE_VIOLATION } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { readSettings } from '../settings/settings.js';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, USERNAME_RE, verifyPassword } from './password.js';
import { AttemptLimiter } from './ratelimit.js';
import { createSession, SESSION_COOKIE } from './sessions.js';
import { describeAgent } from './useragent.js';
import { buildMe, prefsOf } from './users.js';

/**
 * Accounts (docs/12-auth.md): invites and registration, password-reset links, and the person's own
 * name, preferences, password and devices. Field errors are codes; the web app writes the words.
 */

/** XXXX-XXXX from an alphabet without the easily confused I, O, 0 and 1. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newInviteCode(): string {
  const pick = () => ALPHABET[randomInt(ALPHABET.length)];
  return `${Array.from({ length: 4 }, pick).join('')}-${Array.from({ length: 4 }, pick).join('')}`;
}

export const resetHash = (token: string) => createHash('sha256').update(token).digest();
export function newResetToken(): string {
  return randomBytes(32).toString('base64url');
}

const DisplayName = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(20));

const RegisterBody = z.object({
  code: z.string().trim().toUpperCase(),
  displayName: z.string(),
  username: z.string(),
  password: z.string(),
});

/** Field-by-field checks for registration, so every mistake shows at once (docs/11-pages.md). */
function registerFields(b: z.infer<typeof RegisterBody>): Record<string, string> {
  const fields: Record<string, string> = {};
  const name = b.displayName.trim();
  if (name.length === 0) fields.displayName = 'REQUIRED';
  else if ([...name].length > 20) fields.displayName = 'TOO_LONG';
  const user = b.username.trim().toLowerCase();
  if (user.length > 32) fields.username = 'TOO_LONG';
  else if (!USERNAME_RE.test(user)) fields.username = 'FORMAT';
  if (b.password.length < PASSWORD_MIN) fields.password = 'TOO_SHORT';
  else if (b.password.length > PASSWORD_MAX) fields.password = 'TOO_LONG';
  return fields;
}

function setSessionCookie(reply: FastifyReply, deps: Deps, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: deps.config.publicUrl.startsWith('https://'),
    maxAge: 30 * 86_400,
  });
}

type InviteRow = { id: string; role: 'admin' | 'member'; expires_at: Date; used_at: Date | null };

function inviteProblem(inv: InviteRow | null): 'INVITE_NOT_FOUND' | 'INVITE_USED' | 'INVITE_EXPIRED' | null {
  if (!inv) return 'INVITE_NOT_FOUND';
  if (inv.used_at) return 'INVITE_USED';
  if (inv.expires_at.getTime() <= Date.now()) return 'INVITE_EXPIRED';
  return null;
}

export function accountRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  const inviteLimiter = new AttemptLimiter(10, 60_000);
  const resetLimiter = new AttemptLimiter(10, 60_000);
  const limited = (limiter: AttemptLimiter, req: FastifyRequest) => {
    const wait = limiter.retryAfter(req.ip);
    if (wait > 0) throw new ApiError('RATE_LIMITED', 'too many attempts', { retryAfterSeconds: wait });
    limiter.record(req.ip);
  };

  /* -------------------------------------------------------------- invites and registration */

  app.get('/api/invites/:code', async (req) => {
    limited(inviteLimiter, req);
    const { code } = parse(z.object({ code: z.string().max(20) }), req.params);
    const inv = await one<InviteRow>(pool, 'select id, role, expires_at, used_at from invites where code = $1', [
      code.toUpperCase(),
    ]);
    const problem = inviteProblem(inv);
    if (problem || !inv) throw new ApiError(problem ?? 'INVITE_NOT_FOUND', 'invite not usable');
    return { role: inv.role, expiresAt: inv.expires_at.toISOString() };
  });

  /** Creates the account and signs in. The invite is used up in the same transaction. */
  app.post('/api/auth/register', async (req, reply): Promise<Me> => {
    limited(inviteLimiter, req);
    const body = parse(RegisterBody, req.body);
    const fields = registerFields(body);
    if (Object.keys(fields).length) throw new ApiError('VALIDATION', 'registration fields', { fields });
    const username = body.username.trim().toLowerCase();
    const displayName = body.displayName.trim();
    const hash = await hashPassword(body.password);
    const settings = await readSettings(pool);
    let user: { id: string; role: 'admin' | 'member' };
    try {
      user = await tx(pool, async (c) => {
        const inv = await one<InviteRow>(
          c,
          'select id, role, expires_at, used_at from invites where code = $1 for update',
          [body.code],
        );
        const problem = inviteProblem(inv);
        if (problem || !inv) throw new ApiError(problem ?? 'INVITE_NOT_FOUND', 'invite not usable');
        const u = await one<{ id: string }>(
          c,
          `insert into users (username, display_name, password_hash, role, prefs) values ($1, $2, $3, $4, $5) returning id`,
          [username, displayName, hash, inv.role, { langs: settings.subtitles.defaultLangs }],
        );
        if (!u) throw new Error('insert returned nothing');
        await c.query('update invites set used_by = $2, used_at = now() where id = $1', [inv.id, u.id]);
        return { id: u.id, role: inv.role };
      });
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION)
        throw new ApiError('USERNAME_TAKEN', 'username taken', { fields: { username: 'TAKEN' } });
      throw err;
    }
    const token = await createSession(pool, user.id, req.headers['user-agent'] ?? '', req.ip);
    setSessionCookie(reply, deps, token);
    const authed = {
      id: user.id,
      username,
      displayName,
      role: user.role,
      prefs: { langs: settings.subtitles.defaultLangs },
    };
    await audit(pool, authed, 'auth.register', { code: body.code }, req.ip);
    return buildMe(pool, authed);
  });

  /* -------------------------------------------------------------- password reset links */

  const findReset = (token: string) =>
    one<{ id: string; user_id: string; username: string; display_name: string }>(
      pool,
      `select r.id, r.user_id, u.username, u.display_name from password_resets r join users u on u.id = r.user_id
        where r.token_hash = $1 and r.used_at is null and r.expires_at > now()`,
      [resetHash(token)],
    );

  app.get('/api/auth/reset/:token', async (req) => {
    limited(resetLimiter, req);
    const { token } = parse(z.object({ token: z.string().max(100) }), req.params);
    const r = await findReset(token);
    if (!r) throw new ApiError('RESET_INVALID', 'reset link expired or used');
    return { username: r.username };
  });

  app.post('/api/auth/reset/:token', async (req, reply) => {
    limited(resetLimiter, req);
    const { token } = parse(z.object({ token: z.string().max(100) }), req.params);
    const { password } = req.body as { password?: unknown };
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw new ApiError('VALIDATION', 'password', {
        fields: { password: typeof password === 'string' && password.length > PASSWORD_MAX ? 'TOO_LONG' : 'TOO_SHORT' },
      });
    }
    const hash = await hashPassword(password);
    const who = await tx(pool, async (c) => {
      const r = await one<{ id: string; user_id: string; display_name: string }>(
        c,
        `select r.id, r.user_id, u.display_name from password_resets r join users u on u.id = r.user_id
          where r.token_hash = $1 and r.used_at is null and r.expires_at > now() for update of r`,
        [resetHash(token)],
      );
      if (!r) throw new ApiError('RESET_INVALID', 'reset link expired or used');
      await c.query('update password_resets set used_at = now() where id = $1', [r.id]);
      await c.query('update users set password_hash = $2 where id = $1', [r.user_id, hash]);
      await c.query('delete from sessions where user_id = $1', [r.user_id]);
      return { id: r.user_id, displayName: r.display_name };
    });
    await audit(pool, who, 'auth.password.reset', {}, req.ip);
    return reply.status(204).send();
  });

  /* -------------------------------------------------------------- my account */

  app.patch('/api/me', async (req): Promise<User> => {
    const me = requireUser(req);
    const body = parse(
      z.object({
        displayName: DisplayName.optional(),
        prefs: z
          .object({
            langs: z
              .array(z.enum(['zh-Hant', 'zh-Hans', 'en']))
              .min(1)
              .max(3)
              .optional(),
            convertToTraditional: z.boolean().optional(),
            secondLine: z.boolean().optional(),
            quality: z.enum(['720p', '1080p', '2160p']).optional(),
          })
          .strict()
          .optional(),
      }),
      req.body,
    );
    const row = await one<{ display_name: string; prefs: Record<string, unknown> }>(
      pool,
      `update users set display_name = coalesce($2, display_name), prefs = prefs || $3::jsonb where id = $1 returning display_name, prefs`,
      [me.id, body.displayName ?? null, body.prefs ?? {}],
    );
    const settings = await readSettings(pool);
    return {
      id: me.id,
      username: me.username,
      displayName: row?.display_name ?? me.displayName,
      role: me.role,
      prefs: prefsOf(row?.prefs ?? {}, settings.subtitles.defaultLangs),
    };
  });

  app.post('/api/me/password', async (req, reply) => {
    const me = requireUser(req);
    const body = parse(z.object({ current: z.string().max(PASSWORD_MAX), next: z.string() }), req.body);
    if (body.next.length < PASSWORD_MIN || body.next.length > PASSWORD_MAX)
      throw new ApiError('VALIDATION', 'new password', {
        fields: { next: body.next.length < PASSWORD_MIN ? 'TOO_SHORT' : 'TOO_LONG' },
      });
    const row = await one<{ password_hash: string }>(pool, 'select password_hash from users where id = $1', [me.id]);
    if (!(await verifyPassword(row?.password_hash ?? null, body.current)))
      throw new ApiError('WRONG_PASSWORD', 'current password is wrong');
    const hash = await hashPassword(body.next);
    await tx(pool, async (c) => {
      await c.query('update users set password_hash = $2 where id = $1', [me.id, hash]);
      // Every other device signs in again (docs/12-auth.md, "密碼").
      await c.query('delete from sessions where user_id = $1 and id <> $2', [me.id, me.sessionId]);
      await audit(c, me, 'auth.password.change', {}, req.ip);
    });
    return reply.status(204).send();
  });

  app.get('/api/me/sessions', async (req): Promise<Session[]> => {
    const me = requireUser(req);
    const rows = await many<{ id: string; user_agent: string; created_at: Date; last_seen_at: Date }>(
      pool,
      `select id, user_agent, created_at, last_seen_at from sessions where user_id = $1 and expires_at > now() order by last_seen_at desc`,
      [me.id],
    );
    return rows
      .map((r) => ({
        id: r.id,
        ...describeAgent(r.user_agent),
        current: r.id === me.sessionId,
        lastSeenAt: r.last_seen_at.toISOString(),
        createdAt: r.created_at.toISOString(),
      }))
      .sort((a, b) => Number(b.current) - Number(a.current));
  });

  app.delete('/api/me/sessions/:id', async (req, reply) => {
    const me = requireUser(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    if (id === me.sessionId)
      throw new ApiError('VALIDATION', 'use logout for this device', { fields: { id: 'CURRENT' } });
    const r = await one<{ user_agent: string }>(
      pool,
      'delete from sessions where id = $1 and user_id = $2 returning user_agent',
      [id, me.id],
    );
    if (!r) throw new ApiError('NOT_FOUND', 'no such session');
    const d = describeAgent(r.user_agent);
    await audit(pool, me, 'auth.session.revoke', { os: d.os ?? '', browser: d.browser ?? '' }, req.ip);
    return reply.status(204).send();
  });
}
