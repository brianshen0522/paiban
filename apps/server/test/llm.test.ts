import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type Cue, SyncCore, type SyncDoc } from '@paiban/shared';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, LlmPool, sealKey } from '../src/llm/pool.js';
import { moveOldLlmSetting } from '../src/llm/routes.js';
import { chunks, question } from '../src/llm/translate.js';
import { sealSecret } from '../src/settings/secrets.js';
import { film } from './export-helpers.js';
import { call, createUser, login, setSetting, type TestApp, testApp, testDb } from './helpers.js';

/**
 * LLM profiles and subtitle translation (docs/18-llm.md). The models are local stand-ins that
 * speak the OpenAI chat-completions protocol; nothing leaves the machine.
 */
type Seen = {
  url: string;
  auth: string | undefined;
  body: { model?: string; messages?: { content: string }[]; [k: string]: unknown };
};
type Mode = 'ok' | 'rate' | 'auth' | 'english' | 'drop-once' | 'slow' | 'gateway' | 'sse';

/** A model server: translates "N: text" into "譯N", or misbehaves as told. */
async function fakeModel(): Promise<{ url: string; seen: Seen[]; mode: { value: Mode }; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const mode = { value: 'ok' as Mode };
  let dropped = false;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => {
      raw += d;
    });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      seen.push({ url: req.url ?? '', auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.url?.endsWith('/models')) return send(200, { data: [{ id: 'model-b' }, { id: 'model-a' }] });
      if (req.url === '/api/tags') return send(200, { models: [{ name: 'qwen3:8b' }, { name: 'gemma3:4b' }] });
      if (mode.value === 'rate') return send(429, { error: 'slow down' });
      if (mode.value === 'auth') return send(401, { error: 'no' });
      if (mode.value === 'slow') await new Promise((r) => setTimeout(r, 400));
      const user: string = body.messages?.[1]?.content ?? '';
      const part = user.split('Translate these lines:')[1]?.split('\n\n')[0] ?? '';
      let ids = [...part.matchAll(/^(\d+): /gm)].map((m) => Number(m[1]));
      if (mode.value === 'drop-once' && !dropped) {
        dropped = true;
        ids = ids.slice(0, -1);
      }
      const lines = ids.map((id) => ({ id, text: mode.value === 'english' ? `Line ${id}` : `譯${id}` }));
      // A gateway seen in the wild: "event-stream" holding one JSON answer then `data: [DONE]`,
      // and its own {"answer": …} format whenever response_format is sent.
      if (mode.value === 'gateway') {
        const content = body.response_format ? JSON.stringify({ answer: 'ok' }) : JSON.stringify({ lines });
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        return res.end(
          `${JSON.stringify({ model: 'glm-test', choices: [{ message: { content } }] })}\n\ndata: [DONE]\n\n`,
        );
      }
      if (mode.value === 'sse') {
        const content = JSON.stringify({ lines });
        const half = Math.floor(content.length / 2);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of [content.slice(0, half), content.slice(half)])
          res.write(`data: ${JSON.stringify({ model: 'sse-test', choices: [{ delta: { content: piece } }] })}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      // Ollama's own API answers in `message`, the OpenAI protocol in `choices`.
      if (req.url === '/api/chat')
        return send(200, {
          model: body.model,
          message: { role: 'assistant', content: JSON.stringify({ lines }) },
          done: true,
        });
      return send(200, { model: body.model ?? 'fake', choices: [{ message: { content: JSON.stringify({ lines }) } }] });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    seen,
    mode,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

let db: Awaited<ReturnType<typeof testDb>>;
let t: TestApp;
let a: Awaited<ReturnType<typeof fakeModel>>;
let b: Awaited<ReturnType<typeof fakeModel>>;
let boss: string;
let mei: string;
let meiId: string;
let hao: string;

beforeAll(async () => {
  db = await testDb();
  t = await testApp(db.pool);
  a = await fakeModel();
  b = await fakeModel();
  await createUser(db.pool, 'boss', 'admin');
  meiId = await createUser(db.pool, 'mei');
  await createUser(db.pool, 'hao');
  boss = await login(t.app, 'boss');
  mei = await login(t.app, 'mei');
  hao = await login(t.app, 'hao');
});
afterAll(async () => {
  await t.app.close();
  await a.close();
  await b.close();
  await db.drop();
});
beforeEach(async () => {
  await db.pool.query('delete from translations');
  await db.pool.query('delete from llm_usage');
  await db.pool.query('delete from llm_profiles');
  await db.pool.query(`delete from settings where key like 'llm.%'`);
  for (const f of [a, b]) {
    f.seen.length = 0;
    f.mode.value = 'ok';
  }
});

const profile = (over: Record<string, unknown> = {}) => ({
  name: 'Local',
  provider: 'self-hosted',
  baseUrl: a.url,
  apiVersion: '',
  model: 'qwen-test',
  priority: 1,
  weight: 1,
  enabled: true,
  params: DEFAULT_PARAMS,
  ...over,
});
const create = async (over: Record<string, unknown> = {}) => {
  const res = await call(t.app, 'POST', '/api/admin/llm/profiles', { cookie: boss, body: profile(over) });
  expect(res.statusCode).toBe(200);
  return res.json();
};

describe('the pool: load balancing and fallback', () => {
  const pool = (random = () => 0) =>
    new LlmPool({ pool: db.pool, secretKey: t.deps.config.secretKey, log: pino({ level: 'silent' }), random });
  const ask = (p: LlmPool) =>
    p.ask(
      { system: 's', user: 'Translate these lines:\n1: "x"', schema: questionSchema as unknown as never },
      { purpose: 'test', userId: null },
    );
  // The translation answer shape, borrowed from translate.ts through a real question.
  const questionSchema = (() => {
    const q = question({ title: 'T', titleZh: null, year: 1, genres: [], overview: '' }, 'zh-Hant', ['x'], [], [0, 1]);
    return { q };
  })();

  it('shares requests by weight within a priority', async () => {
    await create({ name: 'A', weight: 3, baseUrl: a.url });
    await create({ name: 'B', weight: 1, baseUrl: b.url });
    const { Answer } = await import('../src/llm/translate.js');
    const once = (r: number) =>
      pool(() => r).ask(
        { system: 's', user: 'Translate these lines:\n1: "x"', schema: Answer },
        { purpose: 'test', userId: null },
      );
    // Profiles in name order: A takes [0, 0.75) of the draw, B the rest.
    expect((await once(0.1)).profile).toBe('A');
    expect((await once(0.74)).profile).toBe('A');
    expect((await once(0.8)).profile).toBe('B');
    void ask;
  });

  it('falls back to the next priority when the first is rate limited, and leaves it cooling', async () => {
    await create({ name: 'First', priority: 1, baseUrl: a.url });
    await create({ name: 'Second', priority: 2, baseUrl: b.url });
    const { Answer } = await import('../src/llm/translate.js');
    const p = pool();
    a.mode.value = 'rate';
    const r = await p.ask(
      { system: 's', user: 'Translate these lines:\n1: "x"', schema: Answer },
      { purpose: 'translate', userId: meiId },
    );
    expect(r.profile).toBe('Second');
    expect(a.seen).toHaveLength(1);
    // Cooling: the next request does not knock on the first one again.
    await p.ask(
      { system: 's', user: 'Translate these lines:\n1: "x"', schema: Answer },
      { purpose: 'translate', userId: meiId },
    );
    expect(a.seen).toHaveLength(1);
    const views = (await p.rows()).map((row) => p.view(row));
    expect(views.find((v) => v.name === 'First')).toMatchObject({ lastError: 'RATE_LIMITED' });
    expect(views.find((v) => v.name === 'First')?.coolingUntil).not.toBeNull();
    const usage = (await db.pool.query('select profile_name, purpose, ok, error_code from llm_usage order by id')).rows;
    expect(usage[0]).toMatchObject({
      profile_name: 'First',
      purpose: 'translate',
      ok: false,
      error_code: 'RATE_LIMITED',
    });
    expect(usage[1]).toMatchObject({ profile_name: 'Second', ok: true });
  });

  it('gives the last error when every profile fails, and NOT_CONFIGURED when there is none', async () => {
    const { Answer } = await import('../src/llm/translate.js');
    const req = { system: 's', user: 'Translate these lines:\n1: "x"', schema: Answer };
    await expect(pool().ask(req, { purpose: 'test', userId: null })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    await create({ baseUrl: a.url });
    a.mode.value = 'auth';
    await expect(pool().ask(req, { purpose: 'test', userId: null })).rejects.toMatchObject({ code: 'AUTH' });
    // A disabled profile is never asked.
    await db.pool.query('update llm_profiles set enabled = false');
    await expect(pool().ask(req, { purpose: 'test', userId: null })).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('the LLM settings page', () => {
  it('keeps keys write-only, sealed per profile, and validates the form', async () => {
    const p = await create({ key: 'llm-test-key-not-real' });
    expect(p).toMatchObject({ name: 'Local', keySet: true, coolingUntil: null });
    expect(JSON.stringify(p)).not.toContain('not-real');
    const row = (await db.pool.query('select key_ciphertext from llm_profiles where id = $1', [p.id])).rows[0];
    expect(row.key_ciphertext.toString('latin1')).not.toContain('llm-test-key');
    const page = (await call(t.app, 'GET', '/api/admin/llm', { cookie: boss })).json();
    expect(page.profiles).toHaveLength(1);
    expect(page.translatePerHour).toBe(5);
    expect(JSON.stringify(page)).not.toContain('not-real');
    // Left out: kept. null: cleared.
    expect(
      (
        await call(t.app, 'PUT', `/api/admin/llm/profiles/${p.id}`, {
          cookie: boss,
          body: profile({ name: 'Renamed' }),
        })
      ).json(),
    ).toMatchObject({ name: 'Renamed', keySet: true });
    expect(
      (
        await call(t.app, 'PUT', `/api/admin/llm/profiles/${p.id}`, { cookie: boss, body: profile({ key: null }) })
      ).json(),
    ).toMatchObject({ keySet: false });
    const bad = await call(t.app, 'POST', '/api/admin/llm/profiles', {
      cookie: boss,
      body: profile({ baseUrl: '', model: '' }),
    });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error.details.fields).toEqual({ baseUrl: 'REQUIRED', model: 'REQUIRED' });
    expect(
      (
        await call(t.app, 'POST', '/api/admin/llm/profiles', { cookie: boss, body: profile({ baseUrl: 'ftp://x' }) })
      ).json().error.details.fields,
    ).toEqual({ baseUrl: 'URL_FORMAT' });
    // Claude has a default model and an official address.
    expect(
      (
        await call(t.app, 'POST', '/api/admin/llm/profiles', {
          cookie: boss,
          body: profile({ provider: 'anthropic', baseUrl: '', model: '' }),
        })
      ).statusCode,
    ).toBe(200);
    expect((await call(t.app, 'GET', '/api/admin/llm', { cookie: mei })).statusCode).toBe(403);
    expect((await call(t.app, 'DELETE', `/api/admin/llm/profiles/${p.id}`, { cookie: boss })).statusCode).toBe(204);
    const audit = (
      await db.pool.query(`select action from audit_log where action like 'admin.llm.%' order by id`)
    ).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['admin.llm.create', 'admin.llm.update', 'admin.llm.delete']));
  });

  it('fetches the model list with the typed key, or the stored one when editing', async () => {
    const p = await create({ key: 'stored-key-not-real' });
    const typed = await call(t.app, 'POST', '/api/admin/llm/models', {
      cookie: boss,
      body: { provider: 'self-hosted', baseUrl: a.url, apiVersion: '', key: 'typed-key-not-real' },
    });
    expect(typed.json()).toEqual({ models: ['model-a', 'model-b'] });
    expect(a.seen.at(-1)).toMatchObject({ url: '/v1/models', auth: 'Bearer typed-key-not-real' });
    await call(t.app, 'POST', '/api/admin/llm/models', {
      cookie: boss,
      body: { profileId: p.id, provider: 'self-hosted', baseUrl: a.url, apiVersion: '' },
    });
    expect(a.seen.at(-1)?.auth).toBe('Bearer stored-key-not-real');
  });

  it('tests a profile with the form values, saved or not, and says when the answer is wrong', async () => {
    const ok = (await call(t.app, 'POST', '/api/admin/llm/test', { cookie: boss, body: profile() })).json();
    expect(ok).toMatchObject({ ok: true, code: 'OK', reply: '譯1／譯2' });
    a.mode.value = 'english';
    expect((await call(t.app, 'POST', '/api/admin/llm/test', { cookie: boss, body: profile() })).json()).toMatchObject({
      ok: false,
      code: 'WRONG_ANSWER',
    });
    a.mode.value = 'auth';
    expect((await call(t.app, 'POST', '/api/admin/llm/test', { cookie: boss, body: profile() })).json()).toMatchObject({
      ok: false,
      code: 'AUTH',
    });
    // An unsaved profile's test is recorded too, under the name typed in the form.
    const usage = (await db.pool.query(`select purpose, profile_id, profile_name from llm_usage`)).rows;
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.purpose === 'test' && u.profile_id === null && u.profile_name === 'Local')).toBe(true);
  });

  it("speaks Ollama's own API: the context window, thinking off, a schema for the answer", async () => {
    // Pasted with the /v1 of Ollama's OpenAI-compatible door: stored without it.
    const p = await create({ name: 'Ollama', provider: 'ollama', baseUrl: a.url, model: 'qwen3:8b' });
    expect(p.baseUrl).toBe(a.url.replace(/\/v1$/, ''));
    expect(p.params.contextLength).toBe(16384);
    const models = await call(t.app, 'POST', '/api/admin/llm/models', {
      cookie: boss,
      body: { provider: 'ollama', baseUrl: a.url, apiVersion: '' },
    });
    expect(models.json()).toEqual({ models: ['gemma3:4b', 'qwen3:8b'] });
    const check = await call(t.app, 'POST', '/api/admin/llm/test', {
      cookie: boss,
      body: profile({ provider: 'ollama', model: 'qwen3:8b', params: { ...DEFAULT_PARAMS, contextLength: 32768 } }),
    });
    expect(check.json()).toMatchObject({ ok: true, reply: '譯1／譯2' });
    const sent = a.seen.at(-1);
    expect(sent?.url).toBe('/api/chat');
    expect(sent?.body).toMatchObject({
      model: 'qwen3:8b',
      stream: false,
      think: false,
      options: { num_ctx: 32768, num_predict: DEFAULT_PARAMS.maxTokens },
      format: { type: 'object', properties: { lines: { type: 'array' } } },
    });
    // A profile saved before the context window existed reads with the default.
    const bare = { ...DEFAULT_PARAMS } as Record<string, unknown>;
    delete bare.contextLength;
    expect(
      (await call(t.app, 'POST', '/api/admin/llm/profiles', { cookie: boss, body: profile({ params: bare }) })).json()
        .params.contextLength,
    ).toBe(16384);
    expect(
      (
        await call(t.app, 'POST', '/api/admin/llm/profiles', {
          cookie: boss,
          body: profile({ provider: 'ollama', baseUrl: '' }),
        })
      ).json().error.details.fields,
    ).toEqual({ baseUrl: 'REQUIRED' });
  });

  it('reads answers a gateway wraps as events, and drops response_format when it gets in the way', async () => {
    b.mode.value = 'gateway';
    const first = await call(t.app, 'POST', '/api/admin/llm/test', { cookie: boss, body: profile({ baseUrl: b.url }) });
    expect(first.json()).toMatchObject({ ok: true, reply: '譯1／譯2' });
    expect(b.seen.map((x) => 'response_format' in x.body)).toEqual([true, false]);
    expect(b.seen.every((x) => x.body.stream === false)).toBe(true);
    // Remembered: the next question goes without it straight away.
    await call(t.app, 'POST', '/api/admin/llm/test', { cookie: boss, body: profile({ baseUrl: b.url }) });
    expect(b.seen).toHaveLength(3);
    expect('response_format' in (b.seen[2]?.body ?? {})).toBe(false);
    b.mode.value = 'sse';
    expect(
      (await call(t.app, 'POST', '/api/admin/llm/test', { cookie: boss, body: profile({ baseUrl: b.url }) })).json(),
    ).toMatchObject({ ok: true, reply: '譯1／譯2' });
  });

  it('moves the one model of before into the first profile, its key sealed again', async () => {
    const pool = db.pool;
    await setSetting(pool, 'align.llm.provider', 'openai');
    await setSetting(pool, 'align.llm.model', 'qwen-old');
    await setSetting(pool, 'align.llm.baseUrl', a.url);
    const { nonce, ciphertext } = sealSecret(t.deps.config.secretKey, 'llmKey', 'old-key-not-real');
    await pool.query(
      `insert into secrets (name, nonce, ciphertext) values ('llmKey', $1, $2) on conflict (name) do update set nonce = $1, ciphertext = $2`,
      [nonce, ciphertext],
    );
    await moveOldLlmSetting({ pool, config: t.deps.config, log: pino({ level: 'silent' }) });
    const rows = (await pool.query('select * from llm_profiles')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'self-hosted', model: 'qwen-old', base_url: a.url });
    expect(t.app.llm.key(rows[0])).toBe('old-key-not-real');
    expect((await pool.query(`select 1 from settings where key like 'align.llm.%'`)).rowCount).toBe(0);
    expect((await pool.query(`select 1 from secrets where name = 'llmKey'`)).rowCount).toBe(0);
    // Nothing was asked of the model.
    expect(a.seen).toEqual([]);
    // Running it again changes nothing.
    await moveOldLlmSetting({ pool, config: t.deps.config, log: pino({ level: 'silent' }) });
    expect((await pool.query('select 1 from llm_profiles')).rowCount).toBe(1);
  });
});

describe('translating a subtitle', () => {
  const N = 120;
  /** A film held by Mei with an English subtitle of N lines, synced with an offset and one edited line. */
  async function source(): Promise<{ tid: string; sid: string; doc: SyncDoc }> {
    const dataDir = t.deps.config.dataDir;
    const f = await film(db.pool, dataDir, join(import.meta.dirname, '../../../fixtures/clip.mp4'), [meiId]);
    const cues: Cue[] = Array.from({ length: N }, (_, i) => ({
      id: i + 1,
      start: i * 2,
      end: i * 2 + 1.5,
      text: `Line ${i + 1}`,
    }));
    const doc: SyncDoc = {
      ...SyncCore.identityDoc(),
      segments: [{ from: 0, scale: 1, offset: -2.5 }],
      edits: { '3': { dStart: 0.2, text: 'Line three, edited' }, '4': { deleted: true } },
    };
    const id = randomUUID();
    const json = JSON.stringify(cues);
    await mkdir(join(dataDir, 'subtitles', id), { recursive: true });
    await writeFile(join(dataDir, 'subtitles', id, 'cues.json'), json);
    await db.pool.query(
      `insert into subtitles (id, torrent_id, provider, release_name, language, format, cue_count, rel_dir, sha256, status, doc)
       values ($1, $2, 'upload', 'Film.2026.1080p', 'en', 'srt', $3, $4, $5, 'confirmed', $6)`,
      [id, f.tid, N, `subtitles/${id}`, createHash('sha256').update(json).digest('hex'), doc],
    );
    return { tid: f.tid, sid: id, doc };
  }
  const translate = (
    sid: string,
    body: Record<string, unknown> = { targetLanguage: 'zh-Hant', mode: 'plain' },
    cookie = mei,
  ) => call(t.app, 'POST', `/api/subtitles/${sid}/translate`, { cookie, body });

  it('splits into chunks of 50 with 10 lines of context each side, earlier ones with their translations', () => {
    expect(chunks(120)).toEqual([
      [0, 50],
      [50, 100],
      [100, 120],
    ]);
    const texts = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}`);
    const done = texts.map((_, i) => (i < 50 ? `譯${i + 1}` : null));
    const q = question(
      { title: 'Charade', titleZh: '謎中謎', year: 1963, genres: ['Comedy'], overview: '一筆失蹤的鉅款。' },
      'zh-Hant',
      texts,
      done,
      [50, 100],
    );
    expect(q.ids).toEqual(Array.from({ length: 50 }, (_, i) => 51 + i));
    expect(q.user).toContain('Charade (謎中謎), 1963. Genres: Comedy.');
    expect(q.user).toContain('Synopsis: 一筆失蹤的鉅款。');
    expect(q.user).toContain('41: "Line 41" => "譯41"');
    expect(q.user).not.toContain('40: "Line 40"');
    expect(q.user).toContain('110: "Line 110"');
    expect(q.user).not.toContain('111: "Line 111"');
    expect(q.system).toContain('Taiwan');
  });

  it('says so when no model is set up', async () => {
    const s = await source();
    const res = await translate(s.sid);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('LLM_NOT_CONFIGURED');
  });

  it('translates chunk by chunk into a new subtitle that keeps the original sync, text edits aside', async () => {
    await create({ baseUrl: a.url });
    const s = await source();
    const res = await translate(s.sid);
    expect(res.json()).toMatchObject({ state: 'running', totalChunks: 3, doneChunks: 0, targetLanguage: 'zh-Hant' });
    expect((await translate(s.sid)).json().error.code).toBe('TRANSLATION_RUNNING');
    await t.app.translationWorker.idle();
    const tr = (await call(t.app, 'GET', `/api/torrents/${s.tid}/translations`, { cookie: mei })).json()[0];
    expect(tr).toMatchObject({ state: 'done', doneChunks: 3, errorCode: null });
    const sub = (await db.pool.query('select * from subtitles where id = $1', [tr.resultId])).rows[0];
    expect(sub).toMatchObject({ provider: 'translated', language: 'zh-Hant', cue_count: N, status: 'draft' });
    expect(sub.release_name).toBe('AI 翻譯（qwen-test）· Film.2026.1080p');
    expect(sub.doc.segments).toEqual(s.doc.segments);
    expect(sub.doc.edits).toEqual({ '3': { dStart: 0.2 }, '4': { deleted: true } });
    const cues = JSON.parse(await readFile(join(t.deps.config.dataDir, sub.rel_dir, 'cues.json'), 'utf8'));
    expect(cues.slice(0, 2)).toEqual([
      { id: 1, start: 0, end: 1.5, text: '譯1' },
      { id: 2, start: 2, end: 3.5, text: '譯2' },
    ]);
    expect(await readdir(join(t.deps.config.dataDir, sub.rel_dir))).toEqual(['cues.json', 'original.srt']);
    // Three requests, in order; the second carried the first one's last ten lines and their translations.
    expect(a.seen).toHaveLength(3);
    expect(a.seen[1]?.body.messages?.[1]?.content).toContain('50: "Line 50" => "譯50"');
    const usage = (await db.pool.query(`select purpose, user_id from llm_usage`)).rows;
    expect(usage).toHaveLength(3);
    expect(usage.every((u) => u.purpose === 'translate' && u.user_id === meiId)).toBe(true);
  });

  it('bilingual: the translation over the original, one line', async () => {
    await create({ baseUrl: a.url });
    const s = await source();
    await translate(s.sid, { targetLanguage: 'ja', mode: 'bilingual' });
    await t.app.translationWorker.idle();
    const tr = (await call(t.app, 'GET', `/api/torrents/${s.tid}/translations`, { cookie: mei })).json()[0];
    const sub = (await db.pool.query('select language, rel_dir from subtitles where id = $1', [tr.resultId])).rows[0];
    expect(sub.language).toBe('ja');
    const cues = JSON.parse(await readFile(join(t.deps.config.dataDir, sub.rel_dir, 'cues.json'), 'utf8'));
    expect(cues[0].text).toBe('譯1\nLine 1');
    expect(a.seen[0]?.body.messages?.[0]?.content).toContain('Japanese (ja)');
  });

  it('asks a chunk again when a line is missing from the answer', async () => {
    await create({ baseUrl: a.url });
    a.mode.value = 'drop-once';
    const s = await source();
    await translate(s.sid);
    await t.app.translationWorker.idle();
    const tr = (await call(t.app, 'GET', `/api/torrents/${s.tid}/translations`, { cookie: mei })).json()[0];
    expect(tr.state).toBe('done');
    expect(a.seen).toHaveLength(4);
  });

  it('can be cancelled, writes nothing then, and carries on from where it stopped', async () => {
    await create({ baseUrl: a.url });
    a.mode.value = 'slow';
    const s = await source();
    const id = (await translate(s.sid)).json().id;
    // Let the first chunk finish, then cancel while the second is out.
    for (
      let i = 0;
      i < 100 &&
      (await db.pool.query('select done_chunks from translations where id = $1', [id])).rows[0].done_chunks < 1;
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    expect((await call(t.app, 'POST', `/api/translations/${id}/cancel`, { cookie: mei })).json()).toMatchObject({
      state: 'cancelled',
    });
    await t.app.translationWorker.idle();
    const after = (await db.pool.query('select state, done_chunks, result_id from translations where id = $1', [id]))
      .rows[0];
    expect(after).toMatchObject({ state: 'cancelled', result_id: null });
    expect(
      (await db.pool.query(`select 1 from subtitles where provider = 'translated' and torrent_id = $1`, [s.tid]))
        .rowCount,
    ).toBe(0);
    const askedBefore = a.seen.length;
    a.mode.value = 'ok';
    expect((await call(t.app, 'POST', `/api/translations/${id}/resume`, { cookie: mei })).json()).toMatchObject({
      state: 'running',
    });
    await t.app.translationWorker.idle();
    const done = (await db.pool.query('select state from translations where id = $1', [id])).rows[0];
    expect(done.state).toBe('done');
    // Only the chunks not yet saved were asked again.
    expect(a.seen.length - askedBefore).toBe(3 - after.done_chunks);
  });

  it('starting the same translation again carries on the one that failed, instead of a second', async () => {
    await create({ baseUrl: a.url });
    expect(
      (await call(t.app, 'PUT', '/api/admin/llm/settings', { cookie: boss, body: { translatePerHour: 1 } })).statusCode,
    ).toBe(204);
    a.mode.value = 'auth';
    const s = await source();
    const first = (await translate(s.sid)).json();
    await t.app.translationWorker.idle();
    expect((await db.pool.query('select state from translations where id = $1', [first.id])).rows[0].state).toBe(
      'failed',
    );
    a.mode.value = 'ok';
    // The administrator fixes the key: editing the profile ends its cooling down.
    const p = (await call(t.app, 'GET', '/api/admin/llm', { cookie: boss })).json().profiles[0];
    await call(t.app, 'PUT', `/api/admin/llm/profiles/${p.id}`, {
      cookie: boss,
      body: profile({ key: 'fixed-key-not-real' }),
    });
    // Pressed again from the subtitle, not "carry on": the same row, and not another one off the hourly limit.
    const again = await translate(s.sid);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: first.id, state: 'running' });
    await t.app.translationWorker.idle();
    const list = (await call(t.app, 'GET', `/api/torrents/${s.tid}/translations`, { cookie: mei })).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: first.id, state: 'done' });
    // Another language is another translation.
    expect((await translate(s.sid, { targetLanguage: 'ja', mode: 'plain' })).statusCode).toBe(429);
  });

  it('waits out a short cooling down instead of failing at once', async () => {
    await create({ baseUrl: a.url });
    const { Answer } = await import('../src/llm/translate.js');
    const p = t.app.llm;
    const row = (await p.rows())[0];
    if (!row) throw new Error('no profile');
    // As if the last request had timed out a moment ago: cooling for another 300 ms.
    (p as unknown as { cooling: Map<string, { until: number; code: string }> }).cooling.set(row.id, {
      until: Date.now() + 300,
      code: 'TIMEOUT',
    });
    const r = await p.ask(
      { system: 's', user: 'Translate these lines:\n1: "x"', schema: Answer },
      { purpose: 'test', userId: null },
    );
    expect(r.profile).toBe('Local');
    // A refused key is not waited for.
    (p as unknown as { cooling: Map<string, { until: number; code: string }> }).cooling.set(row.id, {
      until: Date.now() + 600_000,
      code: 'AUTH',
    });
    await expect(
      p.ask({ system: 's', user: 'x', schema: Answer }, { purpose: 'test', userId: null }),
    ).rejects.toMatchObject({ code: 'AUTH' });
    p.reset(row.id);
  });

  it('lists one row per subtitle, language and form: the latest', async () => {
    await create({ baseUrl: a.url });
    const s = await source();
    for (const state of ['failed', 'done'])
      await db.pool.query(
        `insert into translations (torrent_id, source_id, target_language, mode, state, total_chunks, created_at)
         values ($1, $2, 'zh-Hant', 'plain', $3, 3, now() - interval '1 minute' * $4)`,
        [s.tid, s.sid, state, state === 'failed' ? 10 : 1],
      );
    const list = (await call(t.app, 'GET', `/api/torrents/${s.tid}/translations`, { cookie: mei })).json();
    expect(list.map((x: { state: string }) => x.state)).toEqual(['done']);
  });

  it('fails with the reason when every profile fails, and only holders may translate', async () => {
    await create({ baseUrl: a.url });
    a.mode.value = 'auth';
    const s = await source();
    expect((await translate(s.sid, undefined, hao)).statusCode).toBe(403);
    await translate(s.sid);
    await t.app.translationWorker.idle();
    const tr = (await call(t.app, 'GET', `/api/torrents/${s.tid}/translations`, { cookie: mei })).json()[0];
    expect(tr).toMatchObject({ state: 'failed', errorCode: 'AUTH', resultId: null });
  });

  it('keeps to the hourly limit per person', async () => {
    await create({ baseUrl: a.url });
    expect(
      (await call(t.app, 'PUT', '/api/admin/llm/settings', { cookie: boss, body: { translatePerHour: 1 } })).statusCode,
    ).toBe(204);
    const s = await source();
    await translate(s.sid);
    await t.app.translationWorker.idle();
    const res = await translate(s.sid, { targetLanguage: 'ja', mode: 'plain' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.details.retryAfterSeconds).toBeGreaterThan(3000);
    expect((await translate(s.sid, { targetLanguage: 'x y', mode: 'plain' })).statusCode).toBe(422);
  });
});

void sealKey;
