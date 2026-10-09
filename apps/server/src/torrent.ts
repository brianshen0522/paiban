import pg from 'pg';
import { loadConfig } from './config.js';
import { waitForSchema } from './db/migrate.js';
import { createPool } from './db/pool.js';
import { assertSafeEnvironment } from './env.js';
import { type CountryLookup, loadGeoTable } from './geo/geoip.js';
import { startHeartbeat } from './heartbeat.js';
import { createLogger } from './log.js';
import { readSettings } from './settings/settings.js';
import { diskProbe } from './storage/disk.js';
import { createEngine } from './torrent/engine.js';
import { Inspector } from './torrent/inspector.js';
import { homeCountry } from './torrent/live.js';
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

// The IP → country table for the download page's map (built into the image; see deploy/Dockerfile).
// Loading takes seconds on a slow machine, so it happens alongside start-up; until it is in, peers
// show without a country.
let table: CountryLookup | null = null;
const geo: CountryLookup = {
  country: (ip) => table?.country(ip) ?? null,
  get size() {
    return table?.size ?? 0;
  },
};
void loadGeoTable(process.env.GEOIP_CSV).then((t) => {
  table = t;
  log.info({ ranges: t.size }, t.size ? 'country table loaded' : 'no country table: peers show without a country');
});
const worker = new TorrentWorker({
  pool,
  config,
  log,
  engine,
  disk: diskProbe(config.dataDir),
  geo,
  home: homeCountry(process.env.TZ),
});
await worker.recover();
// Magnet links someone is adding by hand: their metadata is fetched here (docs/06, "手動加入").
const inspector = new Inspector(pool, engine, config, log);
await inspector.recover();
const stopHeartbeat = startHeartbeat(pool, 'torrent', () => ({
  port: config.torrentPort,
  dhtPort: config.torrentDhtPort,
  lastIncomingAt: worker.lastIncomingAt,
}));

// Wake-ups from the api (LISTEN on its own connection), plus a pass every 2 seconds.
const listener = new pg.Client({ connectionString: config.databaseUrl });
await listener.connect();
await listener.query('listen paiban_torrent');
await listener.query('listen paiban_inspect');
listener.on('notification', (n) => void (n.channel === 'paiban_inspect' ? inspector.tick() : worker.tick()));
listener.on('error', (err) => {
  log.error({ err }, 'listen connection lost');
  process.exit(1);
});
const timer = setInterval(() => {
  void worker.tick();
  void inspector.tick();
}, 2000);
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
