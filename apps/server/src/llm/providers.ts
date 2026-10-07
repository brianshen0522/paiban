import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { LlmErrorCode, LlmParams, LlmProvider } from '@paiban/shared';
import type { z } from 'zod';

/**
 * One request to one language-model service (docs/18-llm.md): the providers the LLM settings page
 * offers, behind a single "ask for a JSON answer" call. Which profile is asked is the pool's
 * business (pool.ts); this file only knows how to speak to each kind of service.
 */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Everything needed to call one profile; the key already decrypted. */
export type Connection = {
  provider: LlmProvider;
  baseUrl: string;
  apiVersion: string;
  model: string;
  key: string | null;
  params: LlmParams;
};

export type JsonRequest<T> = { system: string; user: string; schema: z.ZodType<T> };

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const DEFAULT_API_VERSION: Partial<Record<LlmProvider, string>> = {
  'azure-openai': '2024-10-21',
  'azure-foundry': '2024-05-01-preview',
};
const OFFICIAL: Partial<Record<LlmProvider, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};
/** Models that accept the server-side fallback on a refusal (docs/08-media-pipeline.md, "語言模型"). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
/** A JSON answer of a few hundred lines is well under this; anything near it is not one. */
const MAX_ANSWER_BYTES = 4 * 1024 * 1024;

const trim = (u: string) => u.trim().replace(/\/+$/, '');

/** The address an administrator typed: http or https, nothing else. */
export function checkBaseUrl(raw: string): string | null {
  const u = trim(raw);
  if (!u) return null;
  try {
    const url = new URL(u);
    return url.protocol === 'http:' || url.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Pull the JSON object out of an answer: thinking tags, code fences and chatter around it go. */
export function extractJson(text: string): unknown {
  const body = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) throw new LlmError('BAD_RESPONSE', 'no JSON object in the answer');
  try {
    return JSON.parse(body.slice(a, b + 1));
  } catch {
    throw new LlmError('BAD_RESPONSE', 'the answer is not valid JSON');
  }
}

/** The body as JSON, or null when it is not JSON; refuses to read past `cap` bytes. */
async function readCapped(res: Response, cap = MAX_ANSWER_BYTES): Promise<unknown> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new LlmError('BAD_RESPONSE', 'the answer is too large');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

/** fetch with the profile's time limit and the caller's abort; an API is never followed through a redirect with the key. */
async function call(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err instanceof DOMException && err.name === 'TimeoutError')
      throw new LlmError('TIMEOUT', `no answer within ${Math.round(timeoutMs / 1000)} s`);
    throw new LlmError('UNREACHABLE', `cannot reach ${new URL(url).host}`);
  }
}

function statusError(status: number): LlmError {
  if (status === 401 || status === 403) return new LlmError('AUTH', 'the key was refused');
  if (status === 429) return new LlmError('RATE_LIMITED', 'rate limited');
  if (status >= 500) return new LlmError('UNREACHABLE', `HTTP ${status}`);
  return new LlmError('BAD_RESPONSE', `HTTP ${status}`);
}

/* ------------------------------------------------------------------ OpenAI-style chat completions */

type ChatTarget = { url: string; headers: Record<string, string>; bodyModel: boolean };

function chatTarget(c: Connection): ChatTarget {
  const key = c.key ?? '';
  switch (c.provider) {
    case 'azure-openai':
      return {
        url: `${trim(c.baseUrl)}/openai/deployments/${encodeURIComponent(c.model)}/chat/completions?api-version=${encodeURIComponent(c.apiVersion || DEFAULT_API_VERSION['azure-openai'] || '')}`,
        headers: key ? { 'api-key': key } : {},
        bodyModel: false,
      };
    case 'azure-foundry':
      return {
        url: `${trim(c.baseUrl)}/models/chat/completions?api-version=${encodeURIComponent(c.apiVersion || DEFAULT_API_VERSION['azure-foundry'] || '')}`,
        headers: key ? { 'api-key': key } : {},
        bodyModel: true,
      };
    default:
      return {
        url: `${trim(c.baseUrl) || OFFICIAL[c.provider] || ''}/chat/completions`,
        headers: key ? { authorization: `Bearer ${key}` } : {},
        bodyModel: true,
      };
  }
}

/**
 * Optional fields a server may refuse with a 400, dropped one step at a time and remembered per
 * address: reasoning models on OpenAI take `max_completion_tokens` and no temperature, older
 * servers know neither `reasoning_effort` nor `response_format`.
 */
const refused = new Map<string, number>();
const STEPS = 4;

function chatBody(c: Connection, t: ChatTarget, system: string, user: string, step: number): object {
  const tokensField = c.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  return {
    ...(t.bodyModel ? { model: c.model } : {}),
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    [tokensField]: c.params.maxTokens,
    ...(step < 3 ? { temperature: c.params.temperature } : {}),
    ...(step < 2 ? { response_format: { type: 'json_object' } } : {}),
    ...(step < 1 && c.params.noReasoning ? { reasoning_effort: 'none' } : {}),
  };
}

const ChatAnswer = {
  parse(body: unknown): { text: string; model: string | null } | null {
    if (!body || typeof body !== 'object') return null;
    const b = body as { choices?: { message?: { content?: unknown } }[]; model?: unknown };
    const content = b.choices?.[0]?.message?.content;
    if (typeof content !== 'string') return null;
    return { text: content, model: typeof b.model === 'string' ? b.model : null };
  },
};

async function openAiStyle<T>(
  c: Connection,
  req: JsonRequest<T>,
  signal?: AbortSignal,
): Promise<{ value: T; model: string }> {
  const t = chatTarget(c);
  if (!t.url.startsWith('http')) throw new LlmError('NOT_CONFIGURED', 'no service address');
  let step = refused.get(t.url) ?? 0;
  for (;;) {
    const res = await call(
      t.url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...t.headers },
        body: JSON.stringify(chatBody(c, t, req.system, req.user, step)),
      },
      c.params.timeoutSeconds * 1000,
      signal,
    );
    if (res.status === 400 && step < STEPS - 1) {
      await res.body?.cancel();
      step++;
      refused.set(t.url, step);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw statusError(res.status);
    }
    const answer = ChatAnswer.parse(await readCapped(res));
    if (!answer) throw new LlmError('BAD_RESPONSE', 'unexpected response shape');
    const parsed = req.schema.safeParse(extractJson(answer.text));
    if (!parsed.success) throw new LlmError('BAD_RESPONSE', 'the answer does not follow the format');
    return { value: parsed.data, model: answer.model ?? c.model };
  }
}

/* ------------------------------------------------------------------ Anthropic */

async function anthropic<T>(
  c: Connection,
  req: JsonRequest<T>,
  signal?: AbortSignal,
): Promise<{ value: T; model: string }> {
  if (!c.key) throw new LlmError('NOT_CONFIGURED', 'no key');
  const model = c.model || DEFAULT_ANTHROPIC_MODEL;
  const client = new Anthropic({
    apiKey: c.key,
    baseURL: checkBaseUrl(c.baseUrl) ?? undefined,
    maxRetries: 1,
    timeout: c.params.timeoutSeconds * 1000,
  });
  try {
    const res = await client.beta.messages.parse(
      {
        model,
        max_tokens: c.params.maxTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        output_config: {
          // biome-ignore lint/suspicious/noExplicitAny: the SDK's helper is typed for zod's own classes
          format: betaZodOutputFormat(req.schema as any),
          ...(model.startsWith('claude-haiku') ? {} : { effort: 'low' as const }),
        },
        ...(FALLBACK_MODELS.has(model)
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
      },
      { signal },
    );
    if (res.stop_reason === 'refusal') throw new LlmError('REFUSED', 'the model declined');
    if (!res.parsed_output) throw new LlmError('BAD_RESPONSE', `no parsable answer (${res.stop_reason})`);
    return { value: res.parsed_output as T, model: res.model };
  } catch (err) {
    if (err instanceof LlmError) throw err;
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
      throw new LlmError('AUTH', 'the key was refused');
    if (err instanceof Anthropic.RateLimitError) throw new LlmError('RATE_LIMITED', 'rate limited');
    if (err instanceof Anthropic.APIConnectionTimeoutError) throw new LlmError('TIMEOUT', 'no answer in time');
    if (err instanceof Anthropic.APIConnectionError) throw new LlmError('UNREACHABLE', 'cannot reach the API');
    if (err instanceof Anthropic.APIError)
      throw (err.status ?? 0) >= 500
        ? new LlmError('UNREACHABLE', `API error ${err.status}`)
        : new LlmError('BAD_RESPONSE', `API error ${err.status}`);
    throw err;
  }
}

/** One question, a JSON answer checked against `schema`. */
export function askJson<T>(
  c: Connection,
  req: JsonRequest<T>,
  signal?: AbortSignal,
): Promise<{ value: T; model: string }> {
  return c.provider === 'anthropic' ? anthropic(c, req, signal) : openAiStyle(c, req, signal);
}

/* ------------------------------------------------------------------ model lists */

const ModelList = (body: unknown): string[] => {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  return data
    .map((m) => (m && typeof m === 'object' ? (m as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length < 200)
    .sort((a, b) => a.localeCompare(b));
};

/**
 * The models a service offers, for the form's suggestion list. Azure OpenAI is asked for its
 * deployments (what the model field means there); Azure AI Foundry has no list, so it is empty.
 */
export async function listModels(c: Omit<Connection, 'model' | 'params'>, timeoutMs = 15_000): Promise<string[]> {
  const key = c.key ?? '';
  if (c.provider === 'azure-foundry') return [];
  if (c.provider === 'anthropic') {
    if (!key) throw new LlmError('NOT_CONFIGURED', 'no key');
    const client = new Anthropic({ apiKey: key, baseURL: checkBaseUrl(c.baseUrl) ?? undefined, timeout: timeoutMs });
    try {
      const ids: string[] = [];
      for await (const m of client.models.list({ limit: 100 })) ids.push(m.id);
      return ids.sort((a, b) => a.localeCompare(b));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
        throw new LlmError('AUTH', 'the key was refused');
      if (err instanceof Anthropic.APIConnectionError) throw new LlmError('UNREACHABLE', 'cannot reach the API');
      throw new LlmError('BAD_RESPONSE', 'the model list could not be read');
    }
  }
  const url =
    c.provider === 'azure-openai'
      ? `${trim(c.baseUrl)}/openai/deployments?api-version=2022-12-01`
      : `${trim(c.baseUrl) || OFFICIAL[c.provider] || ''}/models`;
  if (!url.startsWith('http')) throw new LlmError('NOT_CONFIGURED', 'no service address');
  const headers: Record<string, string> =
    c.provider === 'azure-openai' ? (key ? { 'api-key': key } : {}) : key ? { authorization: `Bearer ${key}` } : {};
  const res = await call(url, { headers }, timeoutMs);
  // Azure resources on newer API versions no longer list deployments: an empty list, not an error.
  if (c.provider === 'azure-openai' && res.status === 404) return [];
  if (!res.ok) {
    await res.body?.cancel();
    throw statusError(res.status);
  }
  return ModelList(await readCapped(res, 2 * 1024 * 1024));
}
