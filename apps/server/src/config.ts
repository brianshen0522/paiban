import { z } from 'zod';

/**
 * Environment of the three services (docs/02-architecture.md, "設定"). Read once at start-up;
 * anything an administrator changes at run time lives in the settings table instead.
 */
const intString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? fallback : Number(v)))
    .pipe(z.number().int().nonnegative());

const EnvSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  DATABASE_URL: z.string().min(1),
  DATA_DIR: z.string().default('/data'),
  PUBLIC_URL: z.string().default('http://localhost:8080'),
  SECRET_KEY: z.string().default(''),
  BOOTSTRAP_ADMIN_USERNAME: z.string().default(''),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default(''),
  STORAGE_LIMIT_GB: intString(50),
  STORAGE_RESERVE_GB: intString(2),
  TORRENT_PORT: intString(51413),
  TORRENT_DHT_PORT: intString(51414),
  PORT: intString(3000),
  LOG_LEVEL: z.string().default('info'),
  ALLOW_LOCAL_SOURCES: z.string().default(''),
  SOURCE_OVERRIDES: z.string().default(''),
  TORRENT_TEST_PEERS: z.string().default(''),
});

export type Config = {
  nodeEnv: 'production' | 'development' | 'test';
  databaseUrl: string;
  dataDir: string;
  publicUrl: string;
  secretKey: string;
  bootstrapAdmin: { username: string; password: string };
  storageLimitGb: number;
  storageReserveBytes: number;
  torrentPort: number;
  torrentDhtPort: number;
  port: number;
  logLevel: string;
  /** Development and tests only (docs/12-auth.md): http:// and internal addresses allowed. */
  allowLocalSources: boolean;
  /** Development and tests only: fixed source host → replacement base URL. */
  sourceOverrides: Record<string, string>;
  /** Development and tests only: host:port peers added to every torrent; DHT and trackers off. */
  torrentTestPeers: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = EnvSchema.parse(env);
  let overrides: Record<string, string> = {};
  if (e.SOURCE_OVERRIDES) {
    const parsed = z.record(z.string(), z.string().url()).safeParse(JSON.parse(e.SOURCE_OVERRIDES));
    if (!parsed.success) throw new Error('SOURCE_OVERRIDES must be a JSON object of host → URL');
    overrides = parsed.data;
  }
  return {
    nodeEnv: e.NODE_ENV,
    databaseUrl: e.DATABASE_URL,
    dataDir: e.DATA_DIR,
    publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
    secretKey: e.SECRET_KEY,
    bootstrapAdmin: { username: e.BOOTSTRAP_ADMIN_USERNAME, password: e.BOOTSTRAP_ADMIN_PASSWORD },
    storageLimitGb: e.STORAGE_LIMIT_GB,
    storageReserveBytes: e.STORAGE_RESERVE_GB * 1024 ** 3,
    torrentPort: e.TORRENT_PORT,
    torrentDhtPort: e.TORRENT_DHT_PORT,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    allowLocalSources: e.ALLOW_LOCAL_SOURCES === '1',
    sourceOverrides: overrides,
    torrentTestPeers: e.TORRENT_TEST_PEERS.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
