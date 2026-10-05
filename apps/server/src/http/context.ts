import type { Logger } from 'pino';
import type { Config } from '../config.js';
import type { Pool } from '../db/pool.js';
import type { EventHub } from '../events/hub.js';
import type { OutboundPolicy } from '../net/outbound.js';
import type { DiskProbe } from '../storage/disk.js';

/** What every route module gets. Tests build their own with a test database and fakes. */
export type Deps = {
  pool: Pool;
  config: Config;
  log: Logger;
  outbound: OutboundPolicy;
  events: EventHub;
  disk: DiskProbe;
};

export type AuthedUser = {
  id: string;
  username: string;
  displayName: string;
  role: 'admin' | 'member';
  prefs: Record<string, unknown>;
  sessionId: string;
};

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthedUser | null;
  }
}
