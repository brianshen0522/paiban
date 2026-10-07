import type { LlmCheck, LlmProfile, LlmProvider, LlmSettings, LlmUsage, Translation } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, type Pool, pgCode, tx, UNIQUE_VIOLATION } from '../db/pool.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin, requireUser } from '../http/guards.js';
import { openSecret } from '../settings/secrets.js';
import { readSettings, writeSettings } from '../settings/settings.js';
import { holderTorrent } from '../torrents/routes.js';
import { DEFAULT_PARAMS, LlmPool, type ProfileRow, sealKey } from './pool.js';
import { type Connection, checkBaseUrl, DEFAULT_API_VERSION, LlmError, listModels } from './providers.js';
import { CHUNK, testQuestion } from './translate.js';
import { TRANSLATION_SELECT, type TranslationRow, TranslationWorker, toTranslation, translationRow } from './worker.js';

declare module 'fastify' {
  interface FastifyInstance {
    llm: LlmPool;
  }
}

const PROVIDERS = ['openai', 'anthropic', 'azure-openai', 'azure-foundry', 'openrouter', 'self-hosted'] as const;
/** The kinds with no official address: the administrator has to give one. */
const NEEDS_URL = new Set<LlmProvider>(['self-hosted', 'azure-openai', 'azure-foundry']);

const Params = z.object({
  temperature: z.number().min(0).max(2),
  maxTokens: z.number().int().min(256).max(32_000),
  timeoutSeconds: z.number().int().min(10).max(600),
  concurrency: z.number().int().min(1).max(16),
  noReasoning: z.boolean(),
});

const ProfileBody = z.object({
  name: z.string().trim().min(1).max(60),
  provider: z.enum(PROVIDERS),
  baseUrl: z.string().trim().max(500),
  apiVersion: z.string().trim().max(40),
  model: z.string().trim().max(200),
  priority: z.number().int().min(1).max(9),
  weight: z.number().int().min(1).max(100),
  enabled: z.boolean(),
  params: Params,
  key: z.string().trim().max(4096).nullable().optional(),
});
type ProfileInput = z.infer<typeof ProfileBody>;

/** Field problems a form shows next to the field (codes; the web app owns the wording). */
function check(b: ProfileInput, forTest = false): Record<string, string> {
  const fields: Record<string, string> = {};
  if (b.baseUrl && !checkBaseUrl(b.baseUrl)) fields.baseUrl = 'URL_FORMAT';
  else if (NEEDS_URL.has(b.provider) && !b.baseUrl) fields.baseUrl = 'REQUIRED';
  // Claude has a default model; every other kind needs one named (for Azure OpenAI, the deployment).
  if (!b.model && b.provider !== 'anthropic') fields.model = 'REQUIRED';
  if (forTest && b.provider === 'anthropic' && b.key === null) fields.key = 'REQUIRED';
  return fields;
}

const IdParams = z.object({ id: z.uuid() });
const ModelsBody = z.object({
  profileId: z.uuid().optional(),
  provider: z.enum(PROVIDERS),
  baseUrl: z.string().trim().max(500),
  apiVersion: z.string().trim().max(40),
  key: z.string().trim().max(4096).optional(),
});

function normalised(b: ProfileInput) {
  return {
    baseUrl: checkBaseUrl(b.baseUrl) ?? '',
    apiVersion: b.provider.startsWith('azure') ? b.apiVersion || (DEFAULT_API_VERSION[b.provider] ?? '') : '',
  };
}

export function llmRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  const llm = new LlmPool({ pool, secretKey: deps.config.secretKey, log: deps.log });
  app.decorate('llm', llm);

  const changed = () => deps.events.toAdmins({ type: 'admin', what: 'llm' });
  const row = (id: string) => one<ProfileRow>(pool, 'select * from llm_profiles where id = $1', [id]);

  app.get('/api/admin/llm', async (req): Promise<LlmSettings> => {
    requireAdmin(req);
    const usage = await many<{
      id: string;
      at: Date;
      profile_id: string | null;
      profile_name: string;
      purpose: LlmUsage['purpose'];
      user_id: string | null;
      display_name: string | null;
      ok: boolean;
      error_code: LlmUsage['errorCode'];
      ms: number;
    }>(
      pool,
      `select u.id, u.at, u.profile_id, u.profile_name, u.purpose, u.user_id, us.display_name, u.ok, u.error_code, u.ms
         from llm_usage u left join users us on us.id = u.user_id order by u.id desc limit 50`,
    );
    return {
      profiles: (await llm.rows()).map((r) => llm.view(r)),
      usage: usage.map((u) => ({
        id: Number(u.id),
        at: u.at.toISOString(),
        profileId: u.profile_id,
        profileName: u.profile_name,
        purpose: u.purpose,
        user: u.user_id ? { id: u.user_id, displayName: u.display_name ?? '' } : null,
        ok: u.ok,
        errorCode: u.error_code,
        ms: u.ms,
      })),
      translatePerHour: (await readSettings(pool)).llm.translatePerHour,
    };
  });

  app.post('/api/admin/llm/profiles', async (req): Promise<LlmProfile> => {
    const user = requireAdmin(req);
    const b = parse(ProfileBody, req.body);
    const fields = check(b);
    if (Object.keys(fields).length) throw new ApiError('VALIDATION', 'invalid profile', { fields });
    const n = normalised(b);
    const created = await tx(pool, async (c) => {
      const r = await one<ProfileRow>(
        c,
        `insert into llm_profiles (name, provider, base_url, api_version, model, priority, weight, enabled, params, updated_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [b.name, b.provider, n.baseUrl, n.apiVersion, b.model, b.priority, b.weight, b.enabled, b.params, user.id],
      );
      if (!r) throw new ApiError('INTERNAL', 'insert failed');
      if (b.key) {
        const sealed = sealKey(deps.config.secretKey, r.id, b.key);
        await c.query('update llm_profiles set key_nonce = $2, key_ciphertext = $3 where id = $1', [
          r.id,
          sealed.nonce,
          sealed.ciphertext,
        ]);
      }
      await audit(c, user, 'admin.llm.create', { name: b.name, provider: b.provider }, req.ip);
      return r.id;
    });
    changed();
    const r = await row(created);
    if (!r) throw new ApiError('NOT_FOUND', 'no such profile');
    return llm.view(r);
  });

  app.put('/api/admin/llm/profiles/:id', async (req): Promise<LlmProfile> => {
    const user = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const b = parse(ProfileBody, req.body);
    const fields = check(b);
    if (Object.keys(fields).length) throw new ApiError('VALIDATION', 'invalid profile', { fields });
    const n = normalised(b);
    await tx(pool, async (c) => {
      const r = await c.query(
        `update llm_profiles set name = $2, provider = $3, base_url = $4, api_version = $5, model = $6, priority = $7,
                weight = $8, enabled = $9, params = $10, updated_by = $11, updated_at = now() where id = $1`,
        [id, b.name, b.provider, n.baseUrl, n.apiVersion, b.model, b.priority, b.weight, b.enabled, b.params, user.id],
      );
      if (!r.rowCount) throw new ApiError('NOT_FOUND', 'no such profile');
      if (b.key === null)
        await c.query('update llm_profiles set key_nonce = null, key_ciphertext = null where id = $1', [id]);
      else if (b.key) {
        const sealed = sealKey(deps.config.secretKey, id, b.key);
        await c.query('update llm_profiles set key_nonce = $2, key_ciphertext = $3 where id = $1', [
          id,
          sealed.nonce,
          sealed.ciphertext,
        ]);
      }
      await audit(c, user, 'admin.llm.update', { name: b.name, provider: b.provider }, req.ip);
    });
    // The administrator changed something; whatever made it cool down may be fixed.
    llm.reset(id);
    changed();
    const r = await row(id);
    if (!r) throw new ApiError('NOT_FOUND', 'no such profile');
    return llm.view(r);
  });

  app.delete('/api/admin/llm/profiles/:id', async (req, reply) => {
    const user = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    await tx(pool, async (c) => {
      const r = await one<{ name: string }>(c, 'delete from llm_profiles where id = $1 returning name', [id]);
      if (!r) throw new ApiError('NOT_FOUND', 'no such profile');
      await audit(c, user, 'admin.llm.delete', { name: r.name }, req.ip);
    });
    llm.reset(id);
    changed();
    return reply.status(204).send();
  });

  /** The key a form means: the one typed, else (editing) the stored one. */
  const keyFor = async (typed: string | null | undefined, profileId: string | undefined): Promise<string | null> => {
    if (typed) return typed;
    if (typed === null || !profileId) return null;
    const r = await row(profileId);
    return r ? llm.key(r) : null;
  };

  app.post('/api/admin/llm/models', async (req): Promise<{ models: string[] }> => {
    requireAdmin(req);
    const b = parse(ModelsBody, req.body);
    if (b.baseUrl && !checkBaseUrl(b.baseUrl))
      throw new ApiError('VALIDATION', 'bad address', { fields: { baseUrl: 'URL_FORMAT' } });
    if (NEEDS_URL.has(b.provider) && !b.baseUrl)
      throw new ApiError('VALIDATION', 'address needed', { fields: { baseUrl: 'REQUIRED' } });
    try {
      return {
        models: await listModels({
          provider: b.provider,
          baseUrl: checkBaseUrl(b.baseUrl) ?? '',
          apiVersion: b.apiVersion,
          key: await keyFor(b.key, b.profileId),
        }),
      };
    } catch (err) {
      if (err instanceof LlmError)
        throw new ApiError('VALIDATION', 'the service did not give a model list', { fields: { model: err.code } });
      throw err;
    }
  });

  app.post('/api/admin/llm/test', async (req): Promise<LlmCheck> => {
    const user = requireAdmin(req);
    const body = parse(ProfileBody.extend({ profileId: z.uuid().optional() }), req.body);
    const fields = check(body);
    if (Object.keys(fields).length) throw new ApiError('VALIDATION', 'invalid profile', { fields });
    const n = normalised(body);
    const c: Connection = {
      provider: body.provider,
      baseUrl: n.baseUrl,
      apiVersion: n.apiVersion,
      model: body.model,
      key: await keyFor(body.key, body.profileId),
      params: { ...DEFAULT_PARAMS, ...body.params, timeoutSeconds: Math.min(body.params.timeoutSeconds, 120) },
    };
    const q = testQuestion();
    const started = Date.now();
    try {
      const out = await llm.askOnce(
        c,
        q.request,
        { purpose: 'test', userId: user.id },
        { id: body.profileId ?? '', name: body.name },
      );
      const right = q.check(out.value);
      return {
        ok: right !== null,
        code: right !== null ? 'OK' : 'WRONG_ANSWER',
        ms: Date.now() - started,
        reply: right,
      };
    } catch (err) {
      const code = err instanceof LlmError ? err.code : 'BAD_RESPONSE';
      return { ok: false, code, ms: Date.now() - started, reply: null };
    }
  });

  app.put('/api/admin/llm/settings', async (req, reply) => {
    const user = requireAdmin(req);
    const { translatePerHour } = parse(z.object({ translatePerHour: z.number().int().min(0).max(100) }), req.body);
    await tx(pool, async (c) => {
      await writeSettings(c, [['llm.translatePerHour', translatePerHour]], user.id);
      await audit(c, user, 'admin.settings.change', { keys: 'llm.translatePerHour' }, req.ip);
    });
    changed();
    return reply.status(204).send();
  });
}

/**
 * Before the LLM settings page, one model was set under 自動對齊 (`align.llm.*` and the `llmKey`
 * secret). On start the api moves it into the first profile, the key sealed again for that row,
 * and removes the old rows. Only data moves; nothing is asked of the model (docs/18-llm.md).
 */
export async function moveOldLlmSetting(deps: Pick<Deps, 'pool' | 'config' | 'log'>): Promise<void> {
  const { pool } = deps;
  const old = new Map(
    (
      await many<{ key: string; value: unknown }>(pool, `select key, value from settings where key like 'align.llm.%'`)
    ).map((r) => [r.key, r.value]),
  );
  const secret = await one<{ nonce: Buffer; ciphertext: Buffer }>(
    pool,
    `select nonce, ciphertext from secrets where name = 'llmKey'`,
  );
  if (!old.size && !secret) return;
  const provider = old.get('align.llm.provider');
  const kind: LlmProvider | null =
    provider === 'anthropic' ? 'anthropic' : provider === 'openai' ? 'self-hosted' : null;
  let key: string | null = null;
  if (secret) {
    try {
      key = openSecret(deps.config.secretKey, 'llmKey', secret.nonce, secret.ciphertext);
    } catch {
      deps.log.warn('the old language-model key cannot be decrypted; it is not moved');
    }
  }
  await moveInto(pool, deps.config.secretKey, kind, old, key);
  deps.log.info({ provider: kind }, 'moved the old language-model setting into the LLM profiles');
}

async function moveInto(
  pool: Pool,
  secretKey: string,
  kind: LlmProvider | null,
  old: Map<string, unknown>,
  key: string | null,
): Promise<void> {
  await tx(pool, async (c) => {
    if (kind && !(await one(c, 'select 1 from llm_profiles limit 1'))) {
      const r = await one<{ id: string }>(
        c,
        `insert into llm_profiles (name, provider, base_url, model, priority, weight, enabled, params)
         values ($1, $2, $3, $4, 1, 1, true, $5) returning id`,
        [
          kind === 'anthropic' ? 'Claude' : '自動對齊（原本的設定）',
          kind,
          kind === 'self-hosted' ? String(old.get('align.llm.baseUrl') ?? '') : '',
          String(old.get('align.llm.model') ?? ''),
          DEFAULT_PARAMS,
        ],
      );
      if (r && key) {
        const sealed = sealKey(secretKey, r.id, key);
        await c.query('update llm_profiles set key_nonce = $2, key_ciphertext = $3 where id = $1', [
          r.id,
          sealed.nonce,
          sealed.ciphertext,
        ]);
      }
    }
    await c.query(`delete from settings where key like 'align.llm.%'`);
    await c.query(`delete from secrets where name = 'llmKey'`);
  });
}

/* ------------------------------------------------------------------ translation (docs/18-llm.md, "字幕翻譯") */

declare module 'fastify' {
  interface FastifyInstance {
    translationWorker: TranslationWorker;
  }
}

const TranslateBody = z.object({
  targetLanguage: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  mode: z.enum(['plain', 'bilingual']),
});

export function translationRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;
  const worker = new TranslationWorker(deps, app.llm);
  app.decorate('translationWorker', worker);
  app.addHook('onClose', async () => worker.stop());

  const mine = async (user: AuthedUser, id: string): Promise<TranslationRow> => {
    const t = await translationRow(pool, id);
    if (!t) throw new ApiError('NOT_FOUND', 'no such translation');
    await holderTorrent(deps, user, t.torrent_id);
    return t;
  };
  const view = async (id: string) => {
    const r = await translationRow(pool, id);
    if (!r) throw new ApiError('NOT_FOUND', 'no such translation');
    return toTranslation(r);
  };

  app.post('/api/subtitles/:id/translate', async (req): Promise<Translation> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(TranslateBody, req.body);
    const s = await one<{ torrent_id: string; cue_count: number }>(
      pool,
      'select torrent_id, cue_count from subtitles where id = $1',
      [id],
    );
    if (!s) throw new ApiError('NOT_FOUND', 'no such subtitle');
    await holderTorrent(deps, user, s.torrent_id);
    if (!(await app.llm.hasProfiles())) throw new ApiError('LLM_NOT_CONFIGURED', 'no language model is set up');
    const limit = (await readSettings(pool)).llm.translatePerHour;
    const recent = await many<{ created_at: Date }>(
      pool,
      `select created_at from translations where created_by = $1 and created_at > now() - interval '1 hour' order by created_at`,
      [user.id],
    );
    if (recent.length >= limit) {
      const oldest = recent[recent.length - limit]?.created_at ?? new Date();
      throw new ApiError('RATE_LIMITED', 'too many translations this hour', {
        retryAfterSeconds: Math.max(1, Math.ceil((oldest.getTime() + 3_600_000 - Date.now()) / 1000)),
      });
    }
    let created: { id: string } | null;
    try {
      created = await one<{ id: string }>(
        pool,
        `insert into translations (torrent_id, source_id, target_language, mode, total_chunks, created_by)
         select $1, $2, $3, $4, $5, $6 from torrents where id = $1 and want <> 'remove' returning id`,
        [s.torrent_id, id, body.targetLanguage, body.mode, Math.max(1, Math.ceil(s.cue_count / CHUNK)), user.id],
      );
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) throw new ApiError('TRANSLATION_RUNNING', 'already being translated');
      throw err;
    }
    if (!created) throw new ApiError('NOT_FOUND', 'the film is being removed');
    await audit(pool, user, 'subtitle.translate.start', { language: body.targetLanguage, mode: body.mode }, req.ip);
    // The answer is what this request started: read before the first chunk can come back.
    const answer = await view(created.id);
    worker.kick(created.id);
    return answer;
  });

  app.get('/api/torrents/:id/translations', async (req): Promise<Translation[]> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    await holderTorrent(deps, user, id);
    const rows = await many<TranslationRow>(
      pool,
      `${TRANSLATION_SELECT} where t.torrent_id = $1 order by t.created_at desc limit 30`,
      [id],
    );
    return rows.map(toTranslation);
  });

  app.post('/api/translations/:id/cancel', async (req): Promise<Translation> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const t = await mine(user, id);
    if (t.state === 'running') {
      await pool.query(
        `update translations set state = 'cancelled', finished_at = now() where id = $1 and state = 'running'`,
        [id],
      );
      worker.cancel(id);
      await audit(pool, user, 'subtitle.translate.cancel', { language: t.target_language }, req.ip);
    }
    return view(id);
  });

  app.post('/api/translations/:id/resume', async (req): Promise<Translation> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const t = await mine(user, id);
    if (t.state !== 'failed' && t.state !== 'cancelled')
      throw new ApiError('VALIDATION', 'only a failed or cancelled translation carries on', {
        fields: { state: t.state.toUpperCase() },
      });
    if (!(await app.llm.hasProfiles())) throw new ApiError('LLM_NOT_CONFIGURED', 'no language model is set up');
    try {
      await pool.query(
        `update translations set state = 'running', error_code = null, finished_at = null where id = $1 and state in ('failed', 'cancelled')`,
        [id],
      );
    } catch (err) {
      if (pgCode(err) === UNIQUE_VIOLATION) throw new ApiError('TRANSLATION_RUNNING', 'already being translated');
      throw err;
    }
    const answer = await view(id);
    worker.kick(id);
    return answer;
  });
}
