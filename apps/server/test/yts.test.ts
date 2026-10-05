import { type FakeYts, startFakeYts } from '@paiban/fakes/yts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { call, createUser, GB, login, setLimit, setSetting, type TestApp, testApp, testDb } from './helpers.js';

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let yts: FakeYts;
let admin: string;
let member: string;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  yts = await startFakeYts();
  await createUser(db.pool, 'boss', 'admin');
  await createUser(db.pool, 'mei', 'member');
  admin = await login(t.app, 'boss');
  member = await login(t.app, 'mei');
  await setLimit(db.pool, 26 * GB);
});
afterAll(async () => {
  await yts.close();
  await t.app.close();
  await db.drop();
});
beforeEach(async () => {
  yts.setMode('ok');
  await db.pool.query('delete from provider_cache');
  await setSetting(db.pool, 'yts.baseUrl', yts.url);
});

describe('search', () => {
  it('needs the YTS address first', async () => {
    await setSetting(db.pool, 'yts.baseUrl', '');
    const res = await call(t.app, 'GET', '/api/yts/movies', { cookie: member });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('YTS_NOT_CONFIGURED');
  });

  it('lists the newest films with poster paths on this server', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies', { cookie: member });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(14);
    expect(body.pageSize).toBe(24);
    expect(body.items[0]).toMatchObject({
      title: 'Night of the Living Dead',
      posterUrl: '/api/yts/movies/1/poster',
      mine: 'none',
    });
    expect(body.items[0].qualities).toEqual(['720p', '1080p', '2160p']);
  });

  it('passes the query, filters and sort through', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies?q=charade', { cookie: member });
    expect(res.json().items.map((m: { title: string }) => m.title)).toEqual(['Charade']);
    const byRating = await call(t.app, 'GET', '/api/yts/movies?sort=rating&genre=sci-fi', { cookie: member });
    expect(byRating.json().items[0].title).toBe('Metropolis');
    expect(yts.requests.some((r) => r.includes('genre=sci-fi') && r.includes('sort_by=rating'))).toBe(true);
    const twoK = await call(t.app, 'GET', '/api/yts/movies?quality=2160p', { cookie: member });
    expect(twoK.json().total).toBe(2);
  });

  it('answers an empty list when YTS has no movies key', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies?q=zzz', { cookie: member });
    expect(res.json()).toMatchObject({ items: [], total: 0 });
  });

  it('caches a search for ten minutes', async () => {
    await call(t.app, 'GET', '/api/yts/movies?q=nosferatu', { cookie: member });
    const before = yts.requests.length;
    await call(t.app, 'GET', '/api/yts/movies?q=nosferatu', { cookie: member });
    expect(yts.requests.length).toBe(before);
  });

  it('reports YTS being down, not looking like YTS, and redirecting to another host', async () => {
    yts.setMode('error500');
    const down = await call(t.app, 'GET', '/api/yts/movies?q=a', { cookie: member });
    expect([down.statusCode, down.json().error.code]).toEqual([502, 'YTS_UNREACHABLE']);
    yts.setMode('html');
    const html = await call(t.app, 'GET', '/api/yts/movies?q=b', { cookie: member });
    expect([html.statusCode, html.json().error.code]).toEqual([502, 'YTS_BAD_RESPONSE']);
    yts.setMode('redirect');
    const moved = await call(t.app, 'GET', '/api/yts/movies?q=c', { cookie: member });
    expect(moved.json().error.code).toBe('YTS_UNREACHABLE');
    // never followed: nothing was asked of the other host
    expect(yts.requests.some((r) => r.includes('yts.example'))).toBe(false);
  });

  it('rejects malformed filters', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies?quality=4k', { cookie: member });
    expect(res.json().error.code).toBe('VALIDATION');
  });
});

describe('film page', () => {
  it('lists every version with play prediction, preview reservation and whether it fits', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies/1', { cookie: member });
    expect(res.statusCode).toBe(200);
    const m = res.json();
    expect(m.stale).toBe(false);
    expect(m.usage.limitBytes).toBe(26 * GB);
    const [v720, , v2160] = m.versions;
    expect(v720).toMatchObject({
      quality: '720p',
      directPlay: true,
      previewBytes: 0,
      local: { kind: 'none', fits: true, shortBytes: 0 },
    });
    expect(v720.infoHash).toMatch(/^[0-9a-f]{40}$/);
    // 96 minutes, x265 10-bit, automatic 480p previews: audio + 480p caps per second.
    expect(v2160).toMatchObject({ directPlay: false, previewBytes: (16_320 + 88_740) * 96 * 60 });
    expect(v2160.needBytes).toBe(v2160.sizeBytes + v2160.previewBytes);
  });

  it('says what is short when a version does not fit', async () => {
    await setLimit(db.pool, 1 * GB);
    const m = (await call(t.app, 'GET', '/api/yts/movies/5', { cookie: member })).json();
    const v1080 = m.versions[1];
    expect(v1080.local.fits).toBe(false);
    expect(v1080.local.shortBytes).toBe(v1080.needBytes - 1 * GB);
    await setLimit(db.pool, 26 * GB);
  });

  it('shows the copy kept from an earlier visit when YTS is down', async () => {
    await call(t.app, 'GET', '/api/yts/movies/3', { cookie: member });
    await db.pool.query(`update provider_cache set expires_at = now() - interval '1 minute'`);
    yts.setMode('error500');
    const res = await call(t.app, 'GET', '/api/yts/movies/3', { cookie: member });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'His Girl Friday', stale: true });
    const never = await call(t.app, 'GET', '/api/yts/movies/4', { cookie: member });
    expect(never.json().error.code).toBe('YTS_UNREACHABLE');
  });

  it('answers 404 for a film YTS does not have', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies/999', { cookie: member });
    expect(res.statusCode).toBe(404);
  });

  it('gives no poster when YTS has none, so the page draws its own', async () => {
    const res = await call(t.app, 'GET', '/api/yts/movies/1/poster', { cookie: member });
    expect(res.statusCode).toBe(404);
  });
});

describe('YTS settings and the connection test', () => {
  it('lets only administrators change settings', async () => {
    const res = await call(t.app, 'PATCH', '/api/admin/settings', {
      cookie: member,
      body: { yts: { baseUrl: 'https://yts.example' } },
    });
    expect(res.statusCode).toBe(403);
  });

  it('validates the address', async () => {
    for (const [value, code] of [
      ['yts.gg', 'URL_FORMAT'],
      ['https://yts.gg/api', 'URL_FORMAT'],
      ['ftp://yts.gg', 'URL_FORMAT'],
    ] as const) {
      const res = await call(t.app, 'PATCH', '/api/admin/settings', {
        cookie: admin,
        body: { yts: { baseUrl: value } },
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toMatchObject({ code: 'SETTING_INVALID', details: { fields: { 'yts.baseUrl': code } } });
    }
    const ok = await call(t.app, 'PATCH', '/api/admin/settings', {
      cookie: admin,
      body: { yts: { baseUrl: `${yts.url}/` } },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().settings.yts.baseUrl).toBe(yts.url);
  });

  it('reports the test result as data, never as an error of the endpoint', async () => {
    const ok = (await call(t.app, 'POST', '/api/admin/sources/yts/test', { cookie: admin })).json();
    expect(ok).toMatchObject({ ok: true, code: 'OK', data: { status: 200, count: 14 } });
    yts.setMode('redirect');
    const moved = await call(t.app, 'POST', '/api/admin/sources/yts/test', { cookie: admin });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ ok: false, code: 'REDIRECTED', data: { host: 'yts.example' } });
    yts.setMode('html');
    expect((await call(t.app, 'POST', '/api/admin/sources/yts/test', { cookie: admin })).json().code).toBe(
      'BAD_RESPONSE',
    );
    const health = (await call(t.app, 'GET', '/api/admin/settings', { cookie: admin })).json().sources;
    expect(health).toEqual([expect.objectContaining({ id: 'yts', state: 'down', code: 'BAD_RESPONSE' })]);
  });

  it('validates download settings together', async () => {
    const res = await call(t.app, 'PATCH', '/api/admin/settings', {
      cookie: admin,
      body: {
        downloads: {
          maxActive: 1,
          maxPerUser: 2,
          stallMinutes: 3,
          trackers: ['udp://ok.example:1337', 'not a tracker'],
        },
      },
    });
    expect(res.json().error.details.fields).toEqual({
      'downloads.maxPerUser': 'ABOVE_MAX_ACTIVE',
      'downloads.stallMinutes': 'INVALID',
      'downloads.trackers': 'LINE_2',
    });
  });
});

describe('internal addresses (production rules)', () => {
  it('refuses an address that points inside the network', async () => {
    const prod = await testApp(db.pool, { allowLocalSources: false });
    try {
      const cookie = await login(prod.app, 'boss');
      for (const value of ['http://yts.gg', 'https://127.0.0.1', 'https://localhost']) {
        const res = await call(prod.app, 'PATCH', '/api/admin/settings', { cookie, body: { yts: { baseUrl: value } } });
        expect(res.json().error.details.fields['yts.baseUrl']).toMatch(/URL_FORMAT|INTERNAL/);
      }
      const internal = await call(prod.app, 'PATCH', '/api/admin/settings', {
        cookie,
        body: { yts: { baseUrl: 'https://127.0.0.1' } },
      });
      expect(internal.json().error.details.fields['yts.baseUrl']).toBe('INTERNAL');
    } finally {
      await prod.app.close();
    }
  });

  it('will not fetch from the fake YTS on loopback without the development switch', async () => {
    const prod = await testApp(db.pool, { allowLocalSources: false });
    try {
      const cookie = await login(prod.app, 'mei');
      const res = await call(prod.app, 'GET', '/api/yts/movies?q=lockdown', { cookie });
      expect(res.json().error.code).toBe('YTS_UNREACHABLE');
      expect(yts.requests.some((r) => r.includes('lockdown'))).toBe(false);
    } finally {
      await prod.app.close();
    }
  });
});
