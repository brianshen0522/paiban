import type { FastifyInstance } from 'fastify';
import { one, type Queryable } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { requireUser } from '../http/guards.js';

const PING_MS = 25_000;

/**
 * Whether an open stream may go on: its session still exists and has not expired, the account is
 * not disabled, and the role is the one the stream was opened with. Checked at every ping, so a
 * disabled, removed, signed-out or demoted account stops receiving events within 25 seconds
 * (docs/12-auth.md, "Disable an account").
 */
export async function streamStillAllowed(q: Queryable, sessionId: string, admin: boolean): Promise<boolean> {
  const r = await one<{ admin: boolean }>(
    q,
    `select u.role = 'admin' as admin from sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.expires_at > now() and not u.disabled`,
    [sessionId],
  );
  return !!r && r.admin === admin;
}

/** GET /api/events: Server-Sent Events. A comment first, then one every 25 seconds (docs/04-api.md). */
export function eventRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/events', (req, reply) => {
    const user = requireUser(req);
    const admin = user.role === 'admin';
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': ok\n\n');
    const remove = deps.events.add({ userId: user.id, admin, write: (chunk) => res.write(chunk) });
    const close = () => {
      clearInterval(beat);
      remove();
    };
    // Ending the stream makes the browser reconnect: a new request, checked like any other.
    const beat = setInterval(() => {
      streamStillAllowed(deps.pool, user.sessionId, admin).then(
        (ok) => {
          if (ok) res.write(': ping\n\n');
          else {
            close();
            res.end();
          }
        },
        () => res.write(': ping\n\n'),
      );
    }, PING_MS);
    req.raw.on('close', close);
  });
}
