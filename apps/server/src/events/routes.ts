import type { FastifyInstance } from 'fastify';
import type { Deps } from '../http/context.js';
import { requireUser } from '../http/guards.js';

/** GET /api/events: Server-Sent Events. A comment first, then one every 25 seconds (docs/04-api.md). */
export function eventRoutes(app: FastifyInstance, deps: Deps): void {
  app.get('/api/events', (req, reply) => {
    const user = requireUser(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': ok\n\n');
    const remove = deps.events.add({
      userId: user.id,
      admin: user.role === 'admin',
      write: (chunk) => res.write(chunk),
    });
    const beat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(beat);
      remove();
    });
  });
}
