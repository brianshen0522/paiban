import pg from 'pg';
import { loadConfig } from './config.js';
import { waitForSchema } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { assertSafeEnvironment } from './env.js';
import { startHeartbeat } from './heartbeat.js';
import { createLogger } from './log.js';
import { readSettings } from './settings/settings.js';
import { diskProbe } from './storage/disk.js';
import { createEngine } from './torrent/engine.js';
import { TorrentWorker } from './torrent/worker.js';

const log = createLogger('torrent');
assertSafeEnvironment(process.env, log);
const config = loadConfig();
const pool = createPool(config.databaseUrl, 4);

await waitForSchema(pool, () => log.info('waiting for the api to apply migrations'));
const settings = await readSettings(pool);
const engine = createEngine({
  torrentPort: config.torrentPort,
  dhtPort: config.torrentDhtPort,
  downloadLimit: settings.downloads.downloadLimitKB * 1024,
  uploadLimit: settings.downloads.uploadLimitKB * 1024,
  offline: config.torrentTestPeers.length > 0,
});
engine.onError((err) => {
  // Fatal for the client (for example the port is taken): let Docker restart the service.
  log.fatal({ err }, 'WebTorrent client error');
  process.exit(1);
});

const worker = new TorrentWorker({ pool, config, log, engine, disk: diskProbe(config.dataDir) });
await worker.recover();
const stopHeartbeat = startHeartbeat(pool, 'torrent', () => ({
  port: config.torrentPort,
  dhtPort: config.torrentDhtPort,
  lastIncomingAt: worker.lastIncomingAt,
}));

// Wake-ups from the api (LISTEN on its own connection), plus a pass every 2 seconds.
const listener = new pg.Client({ connectionString: config.databaseUrl });
await listener.connect();
await listener.query('listen paiban_torrent');
listener.on('notification', () => void worker.tick());
listener.on('error', (err) => {
  log.error({ err }, 'listen connection lost');
  process.exit(1);
});
const timer = setInterval(() => void worker.tick(), 2000);
void worker.tick();
log.info({ port: config.torrentPort, offline: config.torrentTestPeers.length > 0 }, 'torrent service started');

let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'saving progress and stopping');
    clearInterval(timer);
    stopHeartbeat();
    const hardStop = setTimeout(() => process.exit(1), 25_000);
    void worker
      .shutdown()
      .then(() => listener.end())
      .then(() => pool.end())
      .finally(() => {
        clearTimeout(hardStop);
        process.exit(0);
      });
  });
}
