import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL, testDb } from './helpers.js';

/**
 * db/schema.sql is the readable picture of the database; the migrations are what runs. They must
 * describe the same tables, columns, constraints, indexes, functions and views (docs/14-plan.md).
 */
const CATALOG = `
select 'column' as kind, table_name || '.' || column_name as name,
       data_type || coalesce('(' || character_maximum_length || ')', '') || ' ' || is_nullable || ' ' || coalesce(column_default, '') as def
  from information_schema.columns where table_schema = 'public' and table_name <> 'schema_migrations'
union all
select 'constraint', conrelid::regclass || '.' || conname, pg_get_constraintdef(oid)
  from pg_constraint where connamespace = 'public'::regnamespace and conrelid::regclass::text <> 'schema_migrations'
union all
select 'index', tablename || '.' || indexname, indexdef from pg_indexes where schemaname = 'public' and tablename <> 'schema_migrations'
union all
select 'function', proname, pg_get_functiondef(oid) from pg_proc where pronamespace = 'public'::regnamespace
union all
select 'view', viewname, definition from pg_views where schemaname = 'public'
order by 1, 2`;

describe('migrations and db/schema.sql', () => {
  let migrated: Awaited<ReturnType<typeof testDb>>;
  let reference: pg.Client;
  const refName = `paiban_ref_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    migrated = await testDb();
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`create database ${refName}`);
    await admin.end();
    reference = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/[^/]*$/, `/${refName}`) });
    await reference.connect();
    await reference.query(await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8'));
  });

  afterAll(async () => {
    await reference.end();
    await migrated.drop();
    const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    await admin.query(`drop database if exists ${refName} with (force)`);
    await admin.end();
  });

  it('describe the same database', async () => {
    const a = (await migrated.pool.query(CATALOG)).rows;
    const b = (await reference.query(CATALOG)).rows;
    expect(a.length).toBeGreaterThan(100);
    expect(a).toEqual(b);
  });
});
