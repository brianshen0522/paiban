import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { llmHeard } from '../src/asr/align.js';
import type { Pool } from '../src/db/pool.js';
import { DEFAULT_PARAMS, LlmPool, sealKey } from '../src/llm/pool.js';
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
    await pool.query('delete from llm_profiles');
  });

  /** One LLM profile (docs/18-llm.md), as the settings page would make it. */
  const configure = async (provider: 'self-hosted' | 'anthropic', model = 'qwen-test', key?: string) => {
    const r = await pool.query<{ id: string }>(
      `insert into llm_profiles (name, provider, base_url, model, params) values ('test', $1, $2, $3, $4) returning id`,
      [provider, provider === 'self-hosted' ? base : '', model, DEFAULT_PARAMS],
    );
    const id = r.rows[0]?.id ?? '';
    if (key) {
      const { nonce, ciphertext } = sealKey(config.secretKey, id, key);
      await pool.query('update llm_profiles set key_nonce = $2, key_ciphertext = $3 where id = $1', [
        id,
        nonce,
        ciphertext,
      ]);
    }
  };
  // A fresh pool each time: cooling after a failure is kept in memory.
  const heard = (mediaIdArg: string, language: string, l = log) =>
    llmHeard(
      { pool, config, log: l },
      new LlmPool({ pool, secretKey: config.secretKey, log: l }),
      mediaIdArg,
      cues,
      language,
    );

  it('does nothing without a model, or for a subtitle in the language heard', async () => {
    expect(await heard(mediaId, 'fr')).toBeNull();
    await configure('self-hosted');
    expect(await heard(mediaId, 'en')).toBeNull();
    expect(asked).toBe(0);
  });

  it('pairs through an OpenAI-compatible server, with no key needed', async () => {
    await configure('self-hosted');
    const r = await heard(mediaId, 'fr');
    expect(r).toEqual({ language: 'en', pairs: [{ cue: 0, y: 11 }], heardAt: [11], via: 'llm', llmError: null });
    expect(asked).toBe(1);
  });

  it('reports a refused key instead of failing the alignment', async () => {
    await configure('self-hosted', 'qwen-test', 'test-key-not-real');
    status = 401;
    const r = await heard(mediaId, 'fr');
    expect(r).toMatchObject({ via: 'none', pairs: [], llmError: 'AUTH' });
  });

  it('says Claude is not configured when its key is missing, without calling anything', async () => {
    await configure('anthropic', '');
    const r = await heard(mediaId, 'fr');
    expect(r).toMatchObject({ via: 'none', llmError: 'NOT_CONFIGURED' });
    expect(asked).toBe(0);
  });

  it('never writes the key to the log, whether the model answers or refuses it', async () => {
    const lines: string[] = [];
    const captured = pino({ level: 'debug' }, { write: (l: string) => void lines.push(l) });
    await configure('self-hosted', 'qwen-test', 'test-key-not-real');
    await heard(mediaId, 'fr', captured);
    status = 401;
    await heard(mediaId, 'fr', captured);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) {
      expect(l).not.toContain('test-key-not-real');
      expect(l).not.toContain('Bonjour');
    }
  });

  it('does nothing for a film without recognition', async () => {
    await configure('self-hosted');
    expect(await heard('00000000-0000-4000-8000-000000000002', 'fr')).toBeNull();
  });
});
