import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createUser, login, type TestApp, testApp, testDb } from './helpers.js';

/**
 * docs/15-testing.md, "permissions": generated from the route table, so a new route is covered without
 * anyone remembering to add it. Signed out: 401 except the public ones. Member: 403 on /api/admin.
 */
const PUBLIC = new Set([
  'GET /api/health',
  'POST /api/auth/login',
  'GET /api/invites/:code',
  'POST /api/auth/register',
  'GET /api/auth/reset/:token',
  'POST /api/auth/reset/:token',
]);

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let member: string;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  await createUser(db.pool, 'plain');
  member = await login(t.app, 'plain');
});
afterAll(async () => {
  await t.app.close();
  await db.drop();
});

const fill = (url: string) =>
  url.replace(/:[a-zA-Z]+/g, (p) =>
    p === ':ytsId' ? '1' : p === ':code' ? 'ABCD-EFGH' : p === ':token' ? 'x' : '00000000-0000-4000-8000-000000000000',
  );

describe('every route', () => {
  it('is known to the test', () => {
    expect(t.app.routeTable.length).toBeGreaterThan(30);
  });

  it('answers 401 without a session, except the public ones', async () => {
    const leaks: string[] = [];
    for (const r of t.app.routeTable) {
      const key = `${r.method} ${r.url}`;
      if (PUBLIC.has(key) || r.url === '/api/events') continue;
      const res = await call(t.app, r.method as 'GET', fill(r.url), r.method === 'GET' ? {} : { body: {} });
      if (res.statusCode !== 401) leaks.push(`${key} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });

  it('answers 403 to a member on every administrator route', async () => {
    const leaks: string[] = [];
    for (const r of t.app.routeTable.filter((x) => x.url.startsWith('/api/admin/'))) {
      const res = await call(t.app, r.method as 'GET', fill(r.url), {
        cookie: member,
        ...(r.method === 'GET' ? {} : { body: {} }),
      });
      if (res.statusCode !== 403) leaks.push(`${r.method} ${r.url} → ${res.statusCode}`);
    }
    expect(leaks).toEqual([]);
  });
});
