import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapAdmin } from '../src/auth/bootstrap.js';
import { call, createUser, login, type TestApp, testApp, testDb } from './helpers.js';

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  await createUser(db.pool, 'mei', 'member');
});
afterAll(async () => {
  await t.app.close();
  await db.drop();
});

describe('sign-in', () => {
  it('answers 401 before signing in', async () => {
    const res = await call(t.app, 'GET', '/api/auth/me');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('signs in case-insensitively and returns Me without any password or hash', async () => {
    const res = await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'MEI', password: 'test-password-not-real' },
    });
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.user).toMatchObject({ username: 'mei', role: 'member' });
    expect(me.user.prefs).toEqual({
      langs: ['zh-Hant', 'en'],
      convertToTraditional: true,
      secondLine: false,
      quality: '1080p',
    });
    expect(me.limits.maxActiveDownloads).toBe(2);
    expect(res.body).not.toMatch(/argon2|password/i);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/paiban_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it('stores only the hash of the session value', async () => {
    const cookie = await login(t.app, 'mei');
    const value = cookie.split('=')[1] as string;
    const rows = (await db.pool.query('select token_hash from sessions')).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(Buffer.from(r.token_hash).toString('base64url')).not.toBe(value);
  });

  it('gives the same answer for a wrong password and an unknown account', async () => {
    const a = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'mei', password: 'wrong-password' } });
    const b = await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'nobody', password: 'wrong-password' },
    });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.code).toBe('INVALID_CREDENTIALS');
    expect(b.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('says an account is disabled only after the right password', async () => {
    await createUser(db.pool, 'gone', 'member');
    await db.pool.query(`update users set disabled = true where username = 'gone'`);
    const wrong = await call(t.app, 'POST', '/api/auth/login', { body: { username: 'gone', password: 'nope-nope' } });
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const right = await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'gone', password: 'test-password-not-real' },
    });
    expect(right.statusCode).toBe(403);
    expect(right.json().error.code).toBe('ACCOUNT_DISABLED');
  });

  it('locks an account for a while after five failures', async () => {
    await createUser(db.pool, 'target', 'member');
    for (let i = 0; i < 5; i++)
      await call(t.app, 'POST', '/api/auth/login', { body: { username: 'target', password: `wrong-${i}-x` } });
    const res = await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'target', password: 'test-password-not-real' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('logs out and the cookie stops working', async () => {
    const cookie = await login(t.app, 'mei');
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(200);
    expect((await call(t.app, 'POST', '/api/auth/logout', { cookie })).statusCode).toBe(204);
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('ends the session of an account that gets disabled', async () => {
    await createUser(db.pool, 'soon', 'member');
    const cookie = await login(t.app, 'soon');
    await db.pool.query(`update users set disabled = true where username = 'soon'`);
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
  });

  it('writes the sign-in to the activity log without secrets', async () => {
    await login(t.app, 'mei');
    const rows = (await db.pool.query(`select action, target::text from audit_log where action = 'auth.login'`)).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.target).not.toMatch(/password/i);
  });
});

describe('cross-site protection', () => {
  it('refuses writes without X-Requested-With or from another origin', async () => {
    const body = { username: 'mei', password: 'test-password-not-real' };
    const noHeader = await call(t.app, 'POST', '/api/auth/login', { body, headers: { 'x-requested-with': '' } });
    expect(noHeader.statusCode).toBe(403);
    const otherOrigin = await call(t.app, 'POST', '/api/auth/login', {
      body,
      headers: { origin: 'https://evil.example' },
    });
    expect(otherOrigin.statusCode).toBe(403);
  });
});

describe('first administrator (D18)', () => {
  it('is created only into an empty users table, and bad values stop the start', async () => {
    const empty = await testDb();
    try {
      await expect(bootstrapAdmin(empty.pool, { username: 'admin', password: '' })).rejects.toThrow(/both be set/);
      await expect(bootstrapAdmin(empty.pool, { username: 'A dmin', password: 'long-enough' })).rejects.toThrow(
        /USERNAME/,
      );
      await expect(bootstrapAdmin(empty.pool, { username: 'admin', password: 'short' })).rejects.toThrow(/PASSWORD/);
      expect(await bootstrapAdmin(empty.pool, { username: '', password: '' })).toBe('skipped-not-set');
      expect(await bootstrapAdmin(empty.pool, { username: 'Admin', password: 'test-password-not-real' })).toBe(
        'created',
      );
      const u = (await empty.pool.query('select username, role from users')).rows;
      expect(u).toEqual([{ username: 'admin', role: 'admin' }]);
      expect(await bootstrapAdmin(empty.pool, { username: 'other', password: 'test-password-not-real' })).toBe(
        'skipped-users-exist',
      );
    } finally {
      await empty.drop();
    }
  });
});
