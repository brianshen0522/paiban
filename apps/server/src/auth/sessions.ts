import { createHash, randomBytes } from 'node:crypto';
import { SESSION_DAYS } from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { one } from '../db/pool.js';

export const SESSION_COOKIE = 'paiban_session';
const DAY = 86_400_000;

export const tokenHash = (token: string): Buffer => createHash('sha256').update(token).digest();

export type SessionUserRow = {
  session_id: string;
  expires_at: Date;
  last_seen_at: Date;
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  prefs: Record<string, unknown>;
};

/** Creates a session and returns the cookie value. Only its SHA-256 is stored. */
export async function createSession(
  q: Queryable,
  userId: string,
  userAgent: string,
  ip: string | null,
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await q.query(
    `insert into sessions (user_id, token_hash, user_agent, ip, expires_at)
     values ($1, $2, $3, $4, now() + make_interval(days => $5))`,
    [userId, tokenHash(token), userAgent.slice(0, 500), ip, SESSION_DAYS],
  );
  await q.query('update users set last_seen_at = now() where id = $1', [userId]);
  return token;
}

/**
 * The signed-in person for a cookie value, or null. A disabled or removed account has no sessions
 * (they are deleted with it), and expired rows are simply ignored. Extends the session when less
 * than half its life is left and touches last_seen_at at most every five minutes.
 */
export async function lookupSession(q: Queryable, token: string): Promise<SessionUserRow | null> {
  const row = await one<SessionUserRow>(
    q,
    `select s.id as session_id, s.expires_at, s.last_seen_at, u.id, u.username, u.display_name, u.role, u.prefs
       from sessions s join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now() and not u.disabled`,
    [tokenHash(token)],
  );
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at.getTime() - now < (SESSION_DAYS / 2) * DAY || now - row.last_seen_at.getTime() > 5 * 60_000) {
    await q.query(
      `update sessions set last_seen_at = now(),
              expires_at = case when expires_at - now() < make_interval(days => $2) then now() + make_interval(days => $3) else expires_at end
        where id = $1`,
      [row.session_id, SESSION_DAYS / 2, SESSION_DAYS],
    );
    await q.query('update users set last_seen_at = now() where id = $1', [row.id]);
  }
  return row;
}

export async function deleteSession(q: Queryable, sessionId: string): Promise<void> {
  await q.query('delete from sessions where id = $1', [sessionId]);
}
