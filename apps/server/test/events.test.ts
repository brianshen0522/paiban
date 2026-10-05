import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { streamStillAllowed } from '../src/events/routes.js';
import { createUser, login, type TestApp, testApp, testDb } from './helpers.js';

/** docs/12-auth.md: a disabled or demoted account must not keep an open event stream. */
describe('open event streams', () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let t: TestApp;
  beforeAll(async () => {
    db = await testDb();
    t = await testApp(db.pool);
  });
  afterAll(async () => {
    await t.app.close();
    await db.drop();
  });

  const sessionOf = async (userId: string) =>
    (await db.pool.query('select id from sessions where user_id = $1', [userId])).rows[0].id as string;

  it('go on while the session is valid, and stop when the account is disabled', async () => {
    const id = await createUser(db.pool, 'ann');
    await login(t.app, 'ann');
    const s = await sessionOf(id);
    expect(await streamStillAllowed(db.pool, s, false)).toBe(true);
    await db.pool.query('update users set disabled = true where id = $1', [id]);
    expect(await streamStillAllowed(db.pool, s, false)).toBe(false);
  });

  it('stop when the role changes or the session is revoked', async () => {
    const id = await createUser(db.pool, 'bob_admin', 'admin');
    await login(t.app, 'bob_admin');
    const s = await sessionOf(id);
    expect(await streamStillAllowed(db.pool, s, true)).toBe(true);
    await db.pool.query(`update users set role = 'member' where id = $1`, [id]);
    expect(await streamStillAllowed(db.pool, s, true)).toBe(false);
    await db.pool.query('delete from sessions where id = $1', [s]);
    expect(await streamStillAllowed(db.pool, s, false)).toBe(false);
  });
});
