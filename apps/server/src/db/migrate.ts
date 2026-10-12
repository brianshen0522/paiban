import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from './pool.js';

/**
 * Plain SQL migrations, applied in file-name order. 0001_init.sql is db/schema.sql as it was handed
 * over; db/schema.sql stays the readable picture of the whole database and must stay equivalent to
 * the migrations (test/schema-equivalence.test.ts). Only the api runs this; torrent and media wait
 * for `latestMigration()` to appear (docs/02-architecture.md, "Startup and shutdown").
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

async function files(dir = MIGRATIONS_DIR): Promise<string[]> {
  return (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
}

export async function latestMigration(dir = MIGRATIONS_DIR): Promise<string> {
  const all = await files(dir);
  const last = all.at(-1);
  if (!last) throw new Error(`no migrations in ${dir}`);
  return last;
}

export async function migrate(pool: Pool, dir = MIGRATIONS_DIR): Promise<string[]> {
  const c = await pool.connect();
  const applied: string[] = [];
  try {
    await c.query('select pg_advisory_lock(727002)');
    await c.query(
      'create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())',
    );
    const done = new Set(
      (await c.query<{ version: string }>('select version from schema_migrations')).rows.map((r) => r.version),
    );
    for (const f of await files(dir)) {
      if (done.has(f)) continue;
      const sql = await readFile(`${dir}/${f}`, 'utf8');
      await c.query('begin');
      try {
        await c.query(sql);
        await c.query('insert into schema_migrations (version) values ($1)', [f]);
        await c.query('commit');
      } catch (err) {
        await c.query('rollback');
        throw new Error(`migration ${f} failed: ${(err as Error).message}`);
      }
      applied.push(f);
    }
  } finally {
    await c.query('select pg_advisory_unlock(727002)').catch(() => undefined);
    c.release();
  }
  return applied;
}

/** For torrent and media: resolves once the api has applied every migration this build knows. */
export async function waitForSchema(pool: Pool, onWait: () => void, dir = MIGRATIONS_DIR): Promise<void> {
  const want = await latestMigration(dir);
  for (;;) {
    try {
      const r = await pool.query<{ v: string | null }>('select max(version) as v from schema_migrations');
      if (r.rows[0]?.v === want) return;
    } catch {
      // table not there yet
    }
    onWait();
    await new Promise((r) => setTimeout(r, 2000));
  }
}
