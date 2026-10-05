import type { Pool } from '../db/pool.js';
import { hashPassword, PASSWORD_MAX, PASSWORD_MIN, USERNAME_RE } from './password.js';

/**
 * The first administrator comes from the environment, only while the users table is empty
 * (D18, docs/12-auth.md). Bad or half-set values stop the api with a reason instead of producing a
 * site nobody can sign in to. Returns what happened, for the log.
 */
export async function bootstrapAdmin(
  pool: Pool,
  env: { username: string; password: string },
): Promise<'created' | 'skipped-users-exist' | 'skipped-not-set'> {
  const count = Number((await pool.query<{ n: string }>('select count(*) as n from users')).rows[0]?.n ?? 0);
  if (count > 0) return 'skipped-users-exist';
  const username = env.username.trim().toLowerCase();
  const { password } = env;
  if (!username && !password) return 'skipped-not-set';
  if (!username || !password) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD must both be set (or both empty)');
  }
  if (!USERNAME_RE.test(username)) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME must be 3 to 32 lower-case letters, digits or underscores');
  }
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD must be ${PASSWORD_MIN} to ${PASSWORD_MAX} characters`);
  }
  await pool.query(
    `insert into users (username, display_name, password_hash, role)
     select $1, $2, $3, 'admin' where not exists (select 1 from users)`,
    [username, username.slice(0, 20), await hashPassword(password)],
  );
  return 'created';
}
