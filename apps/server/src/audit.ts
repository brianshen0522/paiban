import type { Queryable } from './db/pool.js';

/** One line of the activity log (docs/12-auth.md, "操作紀錄"). Data, never sentences or secrets. */
export async function audit(
  q: Queryable,
  actor: { id: string; displayName: string } | null,
  action: string,
  target: Record<string, string | number> = {},
  ip: string | null = null,
): Promise<void> {
  await q.query('insert into audit_log (actor_id, actor_name, action, target, ip) values ($1, $2, $3, $4, $5)', [
    actor?.id ?? null,
    actor?.displayName ?? '',
    action,
    target,
    ip,
  ]);
}
