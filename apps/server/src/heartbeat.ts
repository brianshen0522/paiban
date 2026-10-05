import { APP_VERSION } from '@paiban/shared';
import type { Pool } from './db/pool.js';

/** Every 10 s each service says it is alive (docs/02-architecture.md). `info` is service specific. */
export function startHeartbeat(
  pool: Pool,
  service: 'api' | 'torrent' | 'media',
  info: () => object = () => ({}),
): () => void {
  const beat = () =>
    pool
      .query(
        `insert into service_heartbeats (service, started_at, last_seen_at, version, info) values ($1, now(), now(), $2, $3)
         on conflict (service) do update set last_seen_at = now(), version = excluded.version, info = excluded.info`,
        [service, APP_VERSION, info()],
      )
      .catch(() => undefined);
  void pool.query(`delete from service_heartbeats where service = $1`, [service]).then(beat, beat);
  const timer = setInterval(beat, 10_000);
  return () => clearInterval(timer);
}
