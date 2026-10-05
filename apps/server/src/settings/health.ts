import type { SourceCheckCode, SourceHealth, SourceId } from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { many } from '../db/pool.js';

/** The latest thing known about a source, overwritten each time (source_health). */
export async function recordSourceHealth(
  q: Queryable,
  source: SourceId,
  state: 'ok' | 'warn' | 'down',
  code: SourceCheckCode,
  data: Record<string, string | number>,
): Promise<void> {
  await q.query(
    `insert into source_health (source, state, code, data, checked_at) values ($1, $2, $3, $4, now())
     on conflict (source) do update set state = excluded.state, code = excluded.code, data = excluded.data, checked_at = now()`,
    [source, state, code, data],
  );
}

export async function readSourceHealth(q: Queryable): Promise<SourceHealth[]> {
  const rows = await many<{
    source: SourceId;
    state: 'ok' | 'warn' | 'down';
    code: SourceCheckCode;
    data: Record<string, string | number>;
    checked_at: Date;
  }>(q, 'select source, state, code, data, checked_at from source_health order by source');
  return rows.map((r) => ({
    id: r.source,
    state: r.state,
    checkedAt: r.checked_at.toISOString(),
    code: r.code,
    data: r.data,
  }));
}
