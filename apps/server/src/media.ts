import { loadConfig } from './config.js';
import { waitForSchema } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { assertSafeEnvironment } from './env.js';
import { startHeartbeat } from './heartbeat.js';
import { createLogger } from './log.js';

/**
 * The media service. Analysis, previews, alignment and export arrive in later phases
 * (docs/14-plan.md); until then it waits for the schema and reports a heartbeat, so the
 * administrator's overview can tell it is running.
 */
const log = createLogger('media');
assertSafeEnvironment(process.env, log);
const config = loadConfig();
const pool = createPool(config.databaseUrl, 2);
await waitForSchema(pool, () => log.info('waiting for the api to apply migrations'));
const stop = startHeartbeat(pool, 'media');
log.info('media service started (no jobs yet)');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    stop();
    log.info({ signal }, 'shutting down');
    void pool.end().finally(() => process.exit(0));
  });
}
