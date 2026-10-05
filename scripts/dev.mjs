#!/usr/bin/env node
// `pnpm dev`: everything for local development, no network and no keys needed (docs/15-testing.md).
//   - PostgreSQL in Docker (deploy/docker-compose.dev.yml, port 55433)
//   - the local seeder serving the three fixture clips as Charade's versions (plus SEED_EXTRA_FILM)
//   - the fake YTS on 127.0.0.1:8090 (the 14 public-domain films)
//   - the fake subtitle sources on 127.0.0.1:8091 (recorded answers for Inception, tt1375666)
//   - api, torrent and media from source (tsx), with the development-only switches
//   - Vite on http://localhost:5173
// Sign in as `admin` / `paiban-dev-not-real` (development values). Files go to .dev-data/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(root, '.dev-data');
const localVersions = join(dataDir, 'local-versions.json');
mkdirSync(dataDir, { recursive: true });

const up = spawnSync('docker', ['compose', '-f', 'deploy/docker-compose.dev.yml', 'up', '-d', '--wait'], {
  cwd: root,
  stdio: 'inherit',
});
if (up.status !== 0) process.exit(up.status ?? 1);

const sources = 'http://127.0.0.1:8091';
const env = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://paiban:paiban-dev-not-real@127.0.0.1:55433/paiban',
  DATA_DIR: dataDir,
  PUBLIC_URL: 'http://localhost:5173',
  SECRET_KEY: 'dev-secret-not-real',
  BOOTSTRAP_ADMIN_USERNAME: 'admin',
  BOOTSTRAP_ADMIN_PASSWORD: 'paiban-dev-not-real',
  STORAGE_LIMIT_GB: '20',
  ALLOW_LOCAL_SOURCES: '1',
  SOURCE_OVERRIDES: JSON.stringify({
    'www.justsubtitles.com': `${sources}/justsubtitles`,
    'api.justsubtitles.com': `${sources}/justsubtitles`,
    'search.justsubtitles.com': `${sources}/justsubtitles-search`,
    'dl.subdl.com': `${sources}/subdl-dl`,
    'api.subdl.com': `${sources}/subdl`,
    'api.themoviedb.org': `${sources}/tmdb`,
    'yts-subs.com': `${sources}/yify`,
    'subtitles.yts-subs.com': `${sources}/yify-dl`,
    'api.assrt.net': `${sources}/assrt`,
    'file.assrt.net': `${sources}/assrt-file`,
  }),
  TORRENT_TEST_PEERS: '127.0.0.1:51801',
  TORRENT_PORT: '51811',
  TORRENT_DHT_PORT: '51812',
  LOCAL_VERSIONS: localVersions,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  // Resolve workspace packages to their sources (the `@paiban/source` export condition), not dist/.
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --conditions=@paiban/source`.trim(),
};

const children = [];
function run(name, cmd, args, cwd) {
  const child = spawn(cmd, args, { cwd: join(root, cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (line) => `${name.padEnd(8)}│ ${line}`;
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) console.log(prefix(l));
    });
  }
  child.on('exit', (code) => console.log(prefix(`exited with ${code}`)));
  children.push(child);
  return child;
}

const tsx = join(root, 'node_modules', '.bin', 'tsx');
// The fake YTS reads the seeder's versions once, so wait for this run's file: hashing a long
// SEED_EXTRA_FILM takes a while, and an old file would list hashes nobody seeds.
rmSync(localVersions, { force: true });
run('seed', 'node', ['src/seed-cli.ts'], 'tools/fakes');
while (!existsSync(localVersions)) await new Promise((r) => setTimeout(r, 500));
run('yts', 'node', ['src/yts-cli.ts'], 'tools/fakes');
run('sources', 'node', ['src/subtitles-cli.ts'], 'tools/fakes');
run('api', tsx, ['watch', 'src/api.ts'], 'apps/server');
run('torrent', tsx, ['src/torrent.ts'], 'apps/server');
run('media', tsx, ['src/media.ts'], 'apps/server');
run('web', 'pnpm', ['exec', 'vite', '--host', '127.0.0.1'], 'apps/web');

console.log('\nOpen http://localhost:5173 and sign in as admin / paiban-dev-not-real.');
console.log('Then set the YTS address to http://127.0.0.1:8090 under 來源設定.\n');

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
