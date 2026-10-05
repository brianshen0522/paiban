import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { llmHeard } from '../src/asr/align.js';
import type { Pool } from '../src/db/pool.js';
import { sealSecret } from '../src/settings/secrets.js';
import { writeSettings } from '../src/settings/settings.js';
import { testConfig, testDb } from './helpers.js';

/**
 * The api's half of alignment by recognised speech (docs/08, "語言模型"): when the subtitle is in
 * another language than the one heard, it asks the configured model before queueing the work.
 * The model here is a local stand-in; no request leaves the machine.
 */
describe('asking the language model from the api', () => {
  let db: Awaited<ReturnType<typeof testDb>>;
  let pool: Pool;
  let server: Server;
  let base = '';
  let asked = 0;
  let status = 200;
  const mediaId = '00000000-0000-4000-8000-000000000001';
  let config = testConfig();
  const log = pino({ level: 'silent' });
  const cues = [
    { id: 1, start: 10, end: 12, text: 'Bonjour.' },
    { id: 2, start: 20, end: 22, text: 'Où es-tu ?' },
  ];

  beforeAll(async () => {
    db = await testDb();
    pool = db.pool;
    server = createServer((req, res) => {
      asked++;
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '{"matches":[{"heard":0,"line":0}]}' } }] }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const dataDir = await mkdtemp(join(tmpdir(), 'paiban-asr-'));
    config = testConfig({ dataDir });
    await mkdir(join(dataDir, 'media', mediaId), { recursive: true });
    await writeFile(
      join(dataDir, 'media', mediaId, 'asr.json'),
      JSON.stringify({
        language: 'en',
        model: 'test',
        windows: [[0, 30]],
        segments: [{ start: 11, end: 12, text: 'Hello.' }],
      }),
    );
  });
  afterAll(async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await db.drop();
  });
  beforeEach(async () => {
    asked = 0;
    status = 200;
    await pool.query('delete from settings');
    await pool.query('delete from secrets');
  });

  const configure = (provider: string, model = 'qwen-test') =>
    writeSettings(
      pool,
      [
        ['align.llm.provider', provider],
        ['align.llm.model', model],
        ['align.llm.baseUrl', base],
      ],
      null,
    );

  it('does nothing without a model, or for a subtitle in the language heard', async () => {
    expect(await llmHeard({ pool, config, log }, mediaId, cues, 'fr')).toBeNull();
    await configure('openai');
    expect(await llmHeard({ pool, config, log }, mediaId, cues, 'en')).toBeNull();
    expect(asked).toBe(0);
  });

  it('pairs through an OpenAI-compatible server, with no key needed', async () => {
    await configure('openai');
    const r = await llmHeard({ pool, config, log }, mediaId, cues, 'fr');
    expect(r).toEqual({ language: 'en', pairs: [{ cue: 0, y: 11 }], via: 'llm', llmError: null });
    expect(asked).toBe(1);
  });

  it('reports a refused key instead of failing the alignment', async () => {
    await configure('openai');
    const { nonce, ciphertext } = sealSecret(config.secretKey, 'llmKey', 'test-key-not-real');
    await pool.query('insert into secrets (name, nonce, ciphertext) values ($1, $2, $3)', [
      'llmKey',
      nonce,
      ciphertext,
    ]);
    status = 401;
    const r = await llmHeard({ pool, config, log }, mediaId, cues, 'fr');
    expect(r).toMatchObject({ via: 'none', pairs: [], llmError: 'AUTH' });
  });

  it('says Claude is not configured when its key is missing, without calling anything', async () => {
    await configure('anthropic', '');
    const r = await llmHeard({ pool, config, log }, mediaId, cues, 'fr');
    expect(r).toMatchObject({ via: 'none', llmError: 'NOT_CONFIGURED' });
    expect(asked).toBe(0);
  });

  it('never writes the key to the log, whether the model answers or refuses it', async () => {
    const lines: string[] = [];
    const captured = pino({ level: 'debug' }, { write: (l: string) => void lines.push(l) });
    await configure('openai');
    const { nonce, ciphertext } = sealSecret(config.secretKey, 'llmKey', 'test-key-not-real');
    await pool.query('insert into secrets (name, nonce, ciphertext) values ($1, $2, $3)', [
      'llmKey',
      nonce,
      ciphertext,
    ]);
    await llmHeard({ pool, config, log: captured }, mediaId, cues, 'fr');
    status = 401;
    await llmHeard({ pool, config, log: captured }, mediaId, cues, 'fr');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      expect(l).not.toContain('test-key-not-real');
      expect(l).not.toContain('Bonjour');
    }
  });

  it('does nothing for a film without recognition', async () => {
    await configure('openai');
    expect(await llmHeard({ pool, config, log }, '00000000-0000-4000-8000-000000000002', cues, 'fr')).toBeNull();
  });
});
