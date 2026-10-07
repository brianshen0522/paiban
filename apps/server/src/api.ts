import { buildApp } from './app.js';
import { bootstrapAdmin } from './auth/bootstrap.js';
import { loadConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { assertSafeEnvironment } from './env.js';
import { EventHub } from './events/hub.js';
import { listenForEvents } from './events/listener.js';
import { startHeartbeat } from './heartbeat.js';
import { moveOldLlmSetting } from './llm/routes.js';
import { createLogger } from './log.js';
import { diskProbe } from './storage/disk.js';
import { ensureInitialLimit } from './storage/usage.js';

const log = createLogger('api');
assertSafeEnvironment(process.env, log);
const config = loadConfig();
const pool = createPool(config.databaseUrl);

// Start-up order from docs/02-architecture.md: migrations, first admin, initial limit, then traffic.
const applied = await migrate(pool);
if (applied.length) log.info({ applied }, 'migrations applied');
const admin = await bootstrapAdmin(pool, config.bootstrapAdmin).catch((err: Error) => {
  log.fatal(err.message);
  process.exit(1);
});
if (admin === 'skipped-not-set') log.warn('no users and no BOOTSTRAP_ADMIN_* variables: nobody can sign in yet');
if (admin === 'created') log.info('first administrator created from BOOTSTRAP_ADMIN_USERNAME');
if (await ensureInitialLimit(pool, config.storageLimitGb))
  log.info({ gb: config.storageLimitGb }, 'initial capacity limit written');

const events = new EventHub();
const app = buildApp({
  pool,
  config,
  log,
  events,
  disk: diskProbe(config.dataDir),
  outbound: {
    allowLocal: config.allowLocalSources,
    overrides: config.sourceOverrides,
    log: (e) => log.debug(e, 'outbound'),
  },
});
const stopListening = listenForEvents(config.databaseUrl, pool, events, log);
const stopHeartbeat = startHeartbeat(pool, 'api');

// The one language-model setting of before moves into the LLM profiles (docs/18-llm.md); data only.
await moveOldLlmSetting({ pool, config, log });
await app.listen({ host: '0.0.0.0', port: config.port });
log.info({ port: config.port }, 'api listening');
// Subtitle searches and downloads left unfinished by the previous run continue (docs/07, "誰做哪一步").
await app.subtitleWorker.start();
// Translations left running carry on from their last finished chunk (docs/18-llm.md).
await app.translationWorker.start();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'shutting down');
    stopHeartbeat();
    void Promise.allSettled([app.close(), stopListening()]).then(() => pool.end().finally(() => process.exit(0)));
  });
}
