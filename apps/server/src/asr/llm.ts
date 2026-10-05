import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { LlmErrorCode, SyncCore } from '@paiban/shared';
import { z } from 'zod';
import type { Pair } from './fit.js';
import { type AsrTranscript, cuesBetween, sourceRange } from './text.js';

type Cue = SyncCore.Cue;

/** A line shown to the model: an id it answers with, a time in seconds, the words. */
export type MatchItem = { id: number; t: number; text: string };
export type MatchRequest = {
  heardLanguage: string;
  subtitleLanguage: string;
  heard: MatchItem[];
  lines: MatchItem[];
};
export type Match = { heard: number; line: number };
/** One request to a language model: which heard lines and subtitle lines say the same thing. */
export type Matcher = (req: MatchRequest, signal?: AbortSignal) => Promise<Match[]>;

export type { LlmErrorCode };
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  constructor(code: LlmErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const Matches = z.object({
  matches: z.array(z.object({ heard: z.number().int(), line: z.number().int() })),
});

/**
 * The instructions. Times are shown only for order and spacing: the subtitle's own times are
 * exactly what is in doubt, so the model is told not to lean on them.
 */
export const SYSTEM = [
  "You pair lines of film dialogue from two sources: speech recognised from the film's audio, and a subtitle file.",
  'The subtitle may be in another language and may be a loose translation. Its times may be shifted by a minute or more, or run at a slightly different speed, so judge by meaning and by the order of the lines; times only show order and spacing.',
  'Return only pairs you are confident of: the subtitle line expresses the same utterance as the recognised line and begins where that utterance begins.',
  'Skip recognised lines that are noise, singing, or short interjections such as "yes", "no" or "hey", and lines with no counterpart.',
  'Each recognised line and each subtitle line may be used at most once, and the pairs must keep the order of both lists.',
  'Answer with JSON only: {"matches": [{"heard": <recognised id>, "line": <subtitle id>}, ...]}. An empty list is a valid answer.',
].join('\n');

export function renderRequest(req: MatchRequest): string {
  const fmt = (prefix: string, items: MatchItem[]) =>
    items.map((x) => `${prefix}${x.id} [${x.t.toFixed(1)}] ${x.text.replace(/\s*\n\s*/g, ' / ')}`).join('\n');
  return [
    `Recognised speech (language: ${req.heardLanguage}). Each line: id, start in seconds, words.`,
    fmt('H', req.heard),
    '',
    `Subtitle lines (language: ${req.subtitleLanguage}). Each line: id, time in the subtitle file, words.`,
    fmt('S', req.lines),
    '',
    'Use the numbers without the H and S prefixes as ids in your answer.',
  ].join('\n');
}

/** Models that accept the server-side fallback on a refusal (docs/08-media-pipeline.md, "語言模型"). */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/**
 * Claude through the Anthropic SDK, with a schema the answer has to follow. `baseUrl` is for a
 * proxy in front of the API; empty means Anthropic's own address.
 */
export function anthropicMatcher(apiKey: string, model: string, baseUrl?: string): Matcher {
  const client = new Anthropic({ apiKey, baseURL: baseUrl || undefined, maxRetries: 2, timeout: 50_000 });
  return async (req, signal) => {
    try {
      const res = await client.beta.messages.parse(
        {
          model,
          max_tokens: 8000,
          system: SYSTEM,
          messages: [{ role: 'user', content: renderRequest(req) }],
          output_config: {
            format: betaZodOutputFormat(Matches),
            // Matching short lines needs little deliberation; Haiku does not take an effort level.
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
      return res.parsed_output.matches;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
        throw new LlmError('AUTH', 'the key was refused');
      if (err instanceof Anthropic.RateLimitError) throw new LlmError('RATE_LIMITED', 'rate limited');
      if (err instanceof Anthropic.APIConnectionError) throw new LlmError('UNREACHABLE', 'cannot reach the API');
      if (err instanceof Anthropic.APIError) throw new LlmError('BAD_RESPONSE', `API error ${err.status}`);
      throw err;
    }
  };
}

const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/** Pull the JSON object out of a chat answer: thinking tags, code fences and chatter around it go. */
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

/**
 * Any server that speaks the OpenAI chat-completions protocol: Qwen through DashScope, a local
 * Ollama or vLLM, and so on. The administrator sets the address, so it may be on the local
 * network; the key is optional because local servers often have none.
 */
export function openAiCompatibleMatcher(
  baseUrl: string,
  apiKey: string | null,
  model: string,
  timeoutMs = 120_000,
): Matcher {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async (req, signal) => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: renderRequest(req) },
          ],
        }),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError')
        throw new LlmError('TIMEOUT', `no answer within ${Math.round(timeoutMs / 1000)} s`);
      throw new LlmError('UNREACHABLE', `cannot reach ${new URL(url).host}`);
    }
    if (res.status === 401 || res.status === 403) throw new LlmError('AUTH', 'the key was refused');
    if (res.status === 429) throw new LlmError('RATE_LIMITED', 'rate limited');
    if (!res.ok) throw new LlmError('BAD_RESPONSE', `HTTP ${res.status}`);
    const parsed = ChatResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new LlmError('BAD_RESPONSE', 'unexpected response shape');
    const answer = Matches.safeParse(extractJson(parsed.data.choices[0].message.content ?? ''));
    if (!answer.success) throw new LlmError('BAD_RESPONSE', 'the answer does not follow the format');
    return answer.data.matches;
  };
}

/** Most subtitle lines shown with one window; a dense film at an unknown speed could offer more. */
const MAX_LINES = 300;
/** Requests at once: a local model server is usually one GPU or CPU; a cloud API takes more. */
export const CONCURRENCY = { local: 3, cloud: 6 } as const;

/**
 * Pairs through a language model, one request per listening window: the recognised lines of
 * that window and every subtitle line that could be at that time (text.ts, sourceRange).
 * Requests run a few at a time (`concurrency`). Answers are checked against what was asked: an id that was not
 * in the request is dropped. A window whose request fails is skipped; when all fail, the first
 * error is thrown so the caller can say why.
 */
export async function llmPairs(
  matcher: Matcher,
  cues: ReadonlyArray<Cue>,
  transcript: AsrTranscript,
  subtitleLanguage: string,
  signal?: AbortSignal,
  concurrency: number = CONCURRENCY.local,
): Promise<{ pairs: Pair[]; failed: number; windows: number }> {
  const jobs: MatchRequest[] = [];
  for (const [start, length] of transcript.windows) {
    const heard: MatchItem[] = [];
    transcript.segments.forEach((s, id) => {
      if (s.start >= start && s.start < start + length && s.text.trim()) heard.push({ id, t: s.start, text: s.text });
    });
    if (!heard.length) continue;
    const [lo, hi] = sourceRange(start, start + length);
    let idx = cuesBetween(cues, lo, hi);
    if (idx.length > MAX_LINES) {
      const centre = start + length / 2;
      idx = idx
        .sort((a, b) => Math.abs(cues[a].start - centre) - Math.abs(cues[b].start - centre))
        .slice(0, MAX_LINES)
        .sort((a, b) => a - b);
    }
    if (!idx.length) continue;
    jobs.push({
      heardLanguage: transcript.language,
      subtitleLanguage,
      heard,
      lines: idx.map((i) => ({ id: i, t: cues[i].start, text: cues[i].text })),
    });
  }
  const pairs: Pair[] = [];
  const errors: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      try {
        const heardIds = new Map(job.heard.map((h) => [h.id, h.t]));
        const lineIds = new Set(job.lines.map((l) => l.id));
        for (const m of await matcher(job, signal)) {
          const y = heardIds.get(m.heard);
          if (y !== undefined && lineIds.has(m.line)) pairs.push({ cue: m.line, y });
        }
      } catch (err) {
        errors.push(err);
        // A refused key or exhausted quota will not get better on the next window.
        if (err instanceof LlmError && (err.code === 'AUTH' || err.code === 'NOT_CONFIGURED')) break;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  if (jobs.length && errors.length >= jobs.length) throw errors[0];
  if (jobs.length && !pairs.length && errors.length) throw errors[0];
  return { pairs, failed: errors.length, windows: jobs.length };
}
