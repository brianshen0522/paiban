import type { Notification } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db/pool.js';
import { NOTIFICATION_JSON } from '../events/publish.js';
import type { Deps } from '../http/context.js';
import { parse, requireUser } from '../http/guards.js';

export function notificationRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/notifications', async (req) => {
    const user = requireUser(req);
    const items = await many<{ n: Notification }>(
      deps.pool,
      `select ${NOTIFICATION_JSON} as n from notifications where user_id = $1 order by id desc limit 50`,
      [user.id],
    );
    const unread = await one<{ n: number }>(
      deps.pool,
      'select count(*)::int as n from notifications where user_id = $1 and read_at is null',
      [user.id],
    );
    return { items: items.map((i) => i.n), unread: unread?.n ?? 0 };
  });

  app.post('/api/notifications/read', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(
      z.object({ ids: z.array(z.number().int()).max(200).optional(), all: z.boolean().optional() }),
      req.body ?? {},
    );
    if (body.all)
      await deps.pool.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [
        user.id,
      ]);
    else if (body.ids?.length)
      await deps.pool.query(
        'update notifications set read_at = now() where user_id = $1 and id = any($2::bigint[]) and read_at is null',
        [user.id, body.ids],
      );
    return reply.status(204).send();
  });
}
