import pg from 'pg';
import { loadConfig } from './config.js';
import { waitForSchema } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { assertSafeEnvironment } from './env.js';
import { startHeartbeat } from './heartbeat.js';
import { createLogger } from './log.js';
import { killAll } from './media/proc.js';
import { MediaService } from './media/service.js';
import { diskProbe } from './storage/disk.js';

/** The media service: analysis and preview assets now; alignment and export in later phases. */
const log = createLogger('media');
assertSafeEnvironment(process.env, log);
const config = loadConfig();
const pool = createPool(config.databaseUrl, 4);
await waitForSchema(pool, () => log.info('waiting for the api to apply migrations'));

const service = new MediaService({ pool, config, log, disk: diskProbe(config.dataDir) });
await service.start();
const stopHeartbeat = startHeartbeat(pool, 'media');

const listener = new pg.Client({ connectionString: config.databaseUrl });
await listener.connect();
await listener.query('listen paiban_media');
listener.on('notification', () => void service.reconcile());
listener.on('error', (err) => {
  log.error({ err }, 'listen connection lost');
  process.exit(1);
});
const timer = setInterval(() => void service.reconcile(), 60_000);
log.info('media service started');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'stopping: ffmpeg is stopped, its .part files are cleaned at the next start');
    service.stop();
    clearInterval(timer);
    stopHeartbeat();
    killAll();
    void Promise.allSettled([listener.end(), pool.end()]).finally(() => process.exit(0));
  });
}
