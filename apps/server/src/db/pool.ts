import pg from 'pg';

// bigint columns (byte counts) come back as strings by default; every count here fits in a
// double (2^53 bytes is 8 PiB), so parse them as numbers once, for every query.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

export type Pool = pg.Pool;
export type Client = pg.PoolClient;
/** Anything a query can run on: the pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export function createPool(databaseUrl: string, max = 10): Pool {
  return new pg.Pool({ connectionString: databaseUrl, max });
}

/** Runs `fn` in a READ COMMITTED transaction (docs/03-data-model.md, "Transaction boundaries"). */
export async function tx<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function one<T extends pg.QueryResultRow>(
  q: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const r = await q.query<T>(sql, params);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow>(
  q: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const r = await q.query<T>(sql, params);
  return r.rows;
}

/** Postgres error code for a unique violation. */
export const UNIQUE_VIOLATION = '23505';
export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;
}
