import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import pino from 'pino';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { EventHub } from '../src/events/hub.js';
import type { Deps } from '../src/http/context.js';

/** The test server: deploy/docker-compose.test.yml. The password is a test value. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://paiban:paiban-test-not-real@127.0.0.1:55432/postgres';
export const PUBLIC_URL = 'http://paiban.test';
export const GB = 1024 ** 3;

/** A fresh database with every migration applied, dropped by `drop()`. */
export async function testDb(): Promise<{ pool: Pool; url: string; drop: () => Promise<void> }> {
  const name = `paiban_t_${Math.random().toString(36).slice(2, 10)}`;
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${name}`);
  const pool = createPool(url, 20);
  await migrate(pool);
  return {
    pool,
    url,
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}

export function testConfig(over: Partial<Config> = {}): Config {
  return {
    nodeEnv: 'test',
    databaseUrl: '',
    dataDir: '/nonexistent',
    publicUrl: PUBLIC_URL,
    secretKey: 'test-key-not-real',
    bootstrapAdmin: { username: '', password: '' },
    storageLimitGb: 50,
    storageReserveBytes: 2 * GB,
    torrentPort: 51413,
    torrentDhtPort: 51414,
    port: 0,
    logLevel: 'silent',
    allowLocalSources: true,
    sourceOverrides: {},
    torrentTestPeers: [],
    ...over,
  };
}

export type TestApp = { app: FastifyInstance; deps: Deps; disk: { totalBytes: number; availableBytes: number } };

export async function testApp(pool: Pool, over: Partial<Config> = {}): Promise<TestApp> {
  const disk = { totalBytes: 1000 * GB, availableBytes: 900 * GB };
  const dataDir = await mkdtemp(join(tmpdir(), 'paiban-data-'));
  const deps: Deps = {
    pool,
    config: testConfig({ dataDir, ...over }),
    log: pino({ level: 'silent' }),
    events: new EventHub(),
    disk: async () => ({ ...disk }),
    outbound: { allowLocal: over.allowLocalSources ?? true, overrides: {} },
  };
  const app = buildApp(deps);
  await app.ready();
  return { app, deps, disk };
}

export async function createUser(
  pool: Pool,
  username: string,
  role: 'admin' | 'member' = 'member',
  password = 'test-password-not-real',
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    'insert into users (username, display_name, password_hash, role) values ($1, $2, $3, $4) returning id',
    [username, username, await hashPassword(password), role],
  );
  return r.rows[0]?.id as string;
}

/** Signs in and returns the cookie header to send with later requests. */
export async function login(
  app: FastifyInstance,
  username: string,
  password = 'test-password-not-real',
): Promise<string> {
  const res = await call(app, 'POST', '/api/auth/login', { body: { username, password } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
  const set = res.headers['set-cookie'];
  const first = Array.isArray(set) ? set[0] : set;
  return String(first).split(';')[0] as string;
}

/** A request as the web app sends it: the anti-CSRF header and the right Origin on writes. */
export function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { ...(opts.cookie ? { cookie: opts.cookie } : {}) };
  if (method !== 'GET') Object.assign(headers, { 'x-requested-with': 'paiban', origin: PUBLIC_URL });
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return app.inject({
    method,
    url,
    headers: { ...headers, ...opts.headers },
    ...(opts.body !== undefined ? { payload: JSON.stringify(opts.body) } : {}),
  });
}

export async function setLimit(pool: Pool, bytes: number): Promise<void> {
  await pool.query(
    `insert into settings (key, value) values ('storage.limitBytes', $1::jsonb) on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(bytes)],
  );
}

export async function setSetting(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `insert into settings (key, value) values ($1, $2::jsonb) on conflict (key) do update set value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}
