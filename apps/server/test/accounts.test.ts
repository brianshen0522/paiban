import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createUser, login, PUBLIC_URL, type TestApp, testApp, testDb } from './helpers.js';

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let boss: string;
let bossId: string;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  bossId = await createUser(db.pool, 'boss', 'admin');
  boss = await login(t.app, 'boss');
});
afterAll(async () => {
  await t.app.close();
  await db.drop();
});

const invite = async (role: 'admin' | 'member' = 'member', days = 7) =>
  (await call(t.app, 'POST', '/api/admin/invites', { cookie: boss, body: { role, days } })).json();
// Registration is limited per address (10 a minute); each call here comes from its own address.
let n = 0;
const ip = () => `10.9.${Math.floor(++n / 250)}.${n % 250}`;
const register = (code: string, username: string, extra: object = {}) =>
  call(t.app, 'POST', '/api/auth/register', {
    body: { code, displayName: username, username, password: 'test-password-not-real', ...extra },
    headers: { 'x-forwarded-for': ip() },
  });

describe('invites and registration (D15)', () => {
  it('makes an XXXX-XXXX code without confusable letters and a link on PUBLIC_URL', async () => {
    const inv = await invite();
    expect(inv.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(inv).toMatchObject({
      url: `${PUBLIC_URL}/invite/${inv.code}`,
      state: 'open',
      role: 'member',
      createdBy: { displayName: 'boss' },
    });
    expect(
      (await call(t.app, 'GET', `/api/invites/${inv.code}`, { headers: { 'x-forwarded-for': ip() } })).json(),
    ).toMatchObject({ role: 'member' });
    const log = (await db.pool.query(`select target::text from audit_log where action = 'admin.invite.create'`))
      .rows[0];
    expect(log.target).not.toContain(inv.code);
  });

  it('registers once, signs in, and uses the invite up', async () => {
    const inv = await invite();
    const res = await register(inv.code, 'amy');
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'amy', role: 'member' });
    expect(String(res.headers['set-cookie'])).toMatch(/paiban_session=/);
    expect((await register(inv.code, 'amy2')).json().error.code).toBe('INVITE_USED');
    expect(
      (await call(t.app, 'GET', `/api/invites/${inv.code}`, { headers: { 'x-forwarded-for': ip() } })).json().error
        .code,
    ).toBe('INVITE_USED');
    const list = (await call(t.app, 'GET', '/api/admin/invites', { cookie: boss })).json();
    expect(list.find((i: { code: string }) => i.code === inv.code)).toMatchObject({
      state: 'used',
      usedBy: { displayName: 'amy' },
    });
  });

  it('gives an admin invite the admin role', async () => {
    const inv = await invite('admin');
    expect((await register(inv.code, 'second_admin')).json().user.role).toBe('admin');
  });

  it('tells apart unknown and expired codes', async () => {
    expect((await register('ZZZZ-ZZZZ', 'nobody')).json().error.code).toBe('INVITE_NOT_FOUND');
    const inv = await invite();
    await db.pool.query(`update invites set expires_at = now() - interval '1 minute' where code = $1`, [inv.code]);
    expect((await register(inv.code, 'late')).json().error.code).toBe('INVITE_EXPIRED');
  });

  it('reports every bad field at once', async () => {
    const inv = await invite();
    const res = await register(inv.code, 'A b', { displayName: '', password: 'short' });
    expect(res.json().error).toMatchObject({
      code: 'VALIDATION',
      details: { fields: { displayName: 'REQUIRED', username: 'FORMAT', password: 'TOO_SHORT' } },
    });
    const long = await register(inv.code, 'x'.repeat(33), { displayName: '名'.repeat(21) });
    expect(long.json().error.details.fields).toEqual({ displayName: 'TOO_LONG', username: 'TOO_LONG' });
  });

  it('refuses a username that exists, whatever its case, and keeps the invite', async () => {
    const inv = await invite();
    const res = await register(inv.code, 'BOSS');
    expect(res.json().error.code).toBe('USERNAME_TAKEN');
    expect(
      (await call(t.app, 'GET', `/api/invites/${inv.code}`, { headers: { 'x-forwarded-for': ip() } })).statusCode,
    ).toBe(200);
  });

  it('lets only one of two people use the same invite at the same moment', async () => {
    const inv = await invite();
    const [a, b] = await Promise.all([register(inv.code, 'racer_a'), register(inv.code, 'racer_b')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 410]);
  });

  it('limits attempts per address', async () => {
    const codes = [];
    for (let i = 0; i < 11; i++)
      codes.push(
        (await call(t.app, 'GET', '/api/invites/ZZZZ-ZZZZ', { headers: { 'x-forwarded-for': '10.250.0.1' } }))
          .statusCode,
      );
    expect(codes.slice(0, 10).every((c) => c === 404)).toBe(true);
    expect(codes[10]).toBe(429);
  });

  it('revokes an open invite', async () => {
    const inv = await invite();
    expect((await call(t.app, 'DELETE', `/api/admin/invites/${inv.id}`, { cookie: boss })).statusCode).toBe(204);
    expect((await register(inv.code, 'too_late')).json().error.code).toBe('INVITE_NOT_FOUND');
  });
});

describe('password reset links (D17)', () => {
  it('work once, for thirty minutes, and sign the person out everywhere', async () => {
    const id = await createUser(db.pool, 'forgetful');
    const old = await login(t.app, 'forgetful');
    const link = (await call(t.app, 'POST', `/api/admin/users/${id}/reset-link`, { cookie: boss })).json();
    expect(link.url).toMatch(new RegExp(`^${PUBLIC_URL}/reset/[A-Za-z0-9_-]{43}$`));
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(29 * 60_000);
    const token = link.url.split('/').pop();
    expect((await call(t.app, 'GET', `/api/auth/reset/${token}`)).json()).toEqual({ username: 'forgetful' });
    expect(
      (await call(t.app, 'POST', `/api/auth/reset/${token}`, { body: { password: 'short' } })).json().error.code,
    ).toBe('VALIDATION');
    expect(
      (await call(t.app, 'POST', `/api/auth/reset/${token}`, { body: { password: 'a-brand-new-password' } }))
        .statusCode,
    ).toBe(204);
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie: old })).statusCode).toBe(401);
    expect(
      (await call(t.app, 'POST', `/api/auth/reset/${token}`, { body: { password: 'another-new-password' } })).json()
        .error.code,
    ).toBe('RESET_INVALID');
    await login(t.app, 'forgetful', 'a-brand-new-password');
    const stored = (await db.pool.query('select token_hash from password_resets')).rows.map((r) =>
      Buffer.from(r.token_hash).toString('base64url'),
    );
    expect(stored).not.toContain(token);
  });

  it('stop working when expired or when a newer one is made', async () => {
    const id = await createUser(db.pool, 'twice');
    const first = (await call(t.app, 'POST', `/api/admin/users/${id}/reset-link`, { cookie: boss }))
      .json()
      .url.split('/')
      .pop();
    const second = (await call(t.app, 'POST', `/api/admin/users/${id}/reset-link`, { cookie: boss }))
      .json()
      .url.split('/')
      .pop();
    expect((await call(t.app, 'GET', `/api/auth/reset/${first}`)).json().error.code).toBe('RESET_INVALID');
    await db.pool.query(`update password_resets set expires_at = now() - interval '1 second'`);
    expect((await call(t.app, 'GET', `/api/auth/reset/${second}`)).json().error.code).toBe('RESET_INVALID');
  });
});

describe('my account', () => {
  it('changes the display name and preferences', async () => {
    await createUser(db.pool, 'pref');
    const cookie = await login(t.app, 'pref');
    const res = await call(t.app, 'PATCH', '/api/me', {
      cookie,
      body: { displayName: ' 美玲 ', prefs: { langs: ['en'], quality: '2160p' } },
    });
    expect(res.json()).toMatchObject({
      displayName: '美玲',
      prefs: { langs: ['en'], quality: '2160p', convertToTraditional: true },
    });
    expect((await call(t.app, 'PATCH', '/api/me', { cookie, body: { prefs: { langs: [] } } })).json().error.code).toBe(
      'VALIDATION',
    );
    expect((await call(t.app, 'PATCH', '/api/me', { cookie, body: { displayName: '' } })).json().error.code).toBe(
      'VALIDATION',
    );
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie })).json().user.displayName).toBe('美玲');
  });

  it('changes the password with the current one and signs out the other devices only', async () => {
    await createUser(db.pool, 'mover');
    const here = await login(t.app, 'mover');
    const there = await login(t.app, 'mover');
    const wrong = await call(t.app, 'POST', '/api/me/password', {
      cookie: here,
      body: { current: 'nope-nope', next: 'new-password-123' },
    });
    expect(wrong.json().error.code).toBe('WRONG_PASSWORD');
    const ok = await call(t.app, 'POST', '/api/me/password', {
      cookie: here,
      body: { current: 'test-password-not-real', next: 'new-password-123' },
    });
    expect(ok.statusCode).toBe(204);
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie: here })).statusCode).toBe(200);
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie: there })).statusCode).toBe(401);
  });

  it('lists devices and signs out another one, but not this one', async () => {
    await createUser(db.pool, 'devices');
    const a = await login(t.app, 'devices');
    await call(t.app, 'POST', '/api/auth/login', {
      body: { username: 'devices', password: 'test-password-not-real' },
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/140 Safari/537.36 Edg/140' },
    });
    const list = (await call(t.app, 'GET', '/api/me/sessions', { cookie: a })).json();
    expect(list).toHaveLength(2);
    expect(list[0].current).toBe(true);
    expect(list[1]).toMatchObject({ current: false, os: 'Windows', browser: 'Edge' });
    expect((await call(t.app, 'DELETE', `/api/me/sessions/${list[0].id}`, { cookie: a })).json().error.code).toBe(
      'VALIDATION',
    );
    expect((await call(t.app, 'DELETE', `/api/me/sessions/${list[1].id}`, { cookie: a })).statusCode).toBe(204);
    expect((await call(t.app, 'GET', '/api/me/sessions', { cookie: a })).json()).toHaveLength(1);
  });
});

describe('administering people', () => {
  it('counts what each person holds', async () => {
    const users = (await call(t.app, 'GET', '/api/admin/users', { cookie: boss })).json();
    expect(users.find((u: { id: string }) => u.id === bossId)).toMatchObject({
      role: 'admin',
      disabled: false,
      held: 0,
      activeDownloads: 0,
      soleHolderOf: 0,
    });
  });

  it('cannot change or remove oneself', async () => {
    expect(
      (await call(t.app, 'PATCH', `/api/admin/users/${bossId}`, { cookie: boss, body: { role: 'member' } })).statusCode,
    ).toBe(403);
    expect((await call(t.app, 'DELETE', `/api/admin/users/${bossId}`, { cookie: boss })).statusCode).toBe(403);
  });

  it('disables (signing out at once), enables and changes roles, with a log line each', async () => {
    const id = await createUser(db.pool, 'target_user');
    const cookie = await login(t.app, 'target_user');
    expect(
      (await call(t.app, 'PATCH', `/api/admin/users/${id}`, { cookie: boss, body: { disabled: true } })).json()
        .disabled,
    ).toBe(true);
    expect((await call(t.app, 'GET', '/api/auth/me', { cookie })).statusCode).toBe(401);
    await call(t.app, 'PATCH', `/api/admin/users/${id}`, { cookie: boss, body: { disabled: false } });
    expect(
      (await call(t.app, 'PATCH', `/api/admin/users/${id}`, { cookie: boss, body: { role: 'admin' } })).json().role,
    ).toBe('admin');
    const actions = (
      await db.pool.query(`select action from audit_log where target->>'name' = 'target_user' order by id`)
    ).rows.map((r) => r.action);
    expect(actions).toEqual(['admin.user.disable', 'admin.user.enable', 'admin.user.role']);
  });

  it('never leaves the site without an enabled administrator, even when two act at once', async () => {
    const db2 = await testDb();
    const t2 = await testApp(db2.pool);
    try {
      const a = await createUser(db2.pool, 'admin_a', 'admin');
      const b = await createUser(db2.pool, 'admin_b', 'admin');
      const ca = await login(t2.app, 'admin_a');
      const cb = await login(t2.app, 'admin_b');
      const [x, y] = await Promise.all([
        call(t2.app, 'PATCH', `/api/admin/users/${b}`, { cookie: ca, body: { role: 'member' } }),
        call(t2.app, 'PATCH', `/api/admin/users/${a}`, { cookie: cb, body: { role: 'member' } }),
      ]);
      const codes = [x, y].map((r) => (r.statusCode === 200 ? 'ok' : r.json().error.code)).sort();
      // Either both demotions race and one is refused, or the second caller is no longer an admin.
      expect(codes[0]).toMatch(/LAST_ADMIN|FORBIDDEN/);
      expect(codes[1]).toBe('ok');
      const admins = (
        await db2.pool.query(`select count(*)::int as n from users where role = 'admin' and not disabled`)
      ).rows[0].n;
      expect(admins).toBe(1);
    } finally {
      await t2.app.close();
      await db2.drop();
    }
  });

  it('removes an account without touching its files', async () => {
    const id = await createUser(db.pool, 'leaver');
    const movie = (
      await db.pool.query(
        `insert into movies (yts_id, imdb_code, title, year) values (77, 'tt7', 'Film', 2000) returning id`,
      )
    ).rows[0].id;
    const tor = (
      await db.pool.query(
        `insert into torrents (info_hash, movie_id, quality, size_bytes, state) values ($1, $2, '720p', 100, 'completed') returning id`,
        ['c'.repeat(40), movie],
      )
    ).rows[0].id;
    await db.pool.query('insert into torrent_holders (torrent_id, user_id) values ($1, $2)', [tor, id]);
    const before = (await call(t.app, 'GET', '/api/admin/users', { cookie: boss }))
      .json()
      .find((u: { id: string }) => u.id === id);
    expect(before).toMatchObject({ held: 1, soleHolderOf: 1 });
    expect((await call(t.app, 'DELETE', `/api/admin/users/${id}`, { cookie: boss })).statusCode).toBe(204);
    const left = (await db.pool.query('select want from torrents where id = $1', [tor])).rows[0];
    expect(left).toEqual({ want: 'run' });
  });
});

describe('the activity log', () => {
  it('pages fifty at a time, newest first, and filters by person', async () => {
    for (let i = 0; i < 55; i++)
      await db.pool.query(`insert into audit_log (actor_id, actor_name, action) values ($1, 'boss', 'auth.login')`, [
        bossId,
      ]);
    const first = (await call(t.app, 'GET', '/api/admin/audit', { cookie: boss })).json();
    expect(first.items).toHaveLength(50);
    expect(first.items[0].id).toBeGreaterThan(first.items[49].id);
    expect(first.nextBefore).toBe(first.items[49].id);
    const next = (await call(t.app, 'GET', `/api/admin/audit?before=${first.nextBefore}`, { cookie: boss })).json();
    expect(next.items[0].id).toBeLessThan(first.nextBefore);
    const mine = (await call(t.app, 'GET', `/api/admin/audit?userId=${bossId}`, { cookie: boss })).json();
    expect(mine.items.every((e: { actor: { id: string } }) => e.actor?.id === bossId)).toBe(true);
  });
});
