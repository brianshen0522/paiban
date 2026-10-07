import type { SyncCore } from '@paiban/shared';
import { z } from 'zod';
import type { Caller, LlmPool } from '../llm/pool.js';
import { askJson, type Connection, LlmError } from '../llm/providers.js';
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

export { LlmError };

export const Matches = z.object({
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

/** Pairs through one profile (tests, and anything that holds a connection already). */
export function connectionMatcher(c: Connection): Matcher {
  return async (req, signal) =>
    (await askJson(c, { system: SYSTEM, user: renderRequest(req), schema: Matches }, signal)).value.matches;
}

/** Pairs through the LLM profiles (docs/18-llm.md): load balancing and fallback are the pool's. */
export function poolMatcher(pool: LlmPool, caller: Omit<Caller, 'signal'>): Matcher {
  return async (req, signal) =>
    (await pool.ask({ system: SYSTEM, user: renderRequest(req), schema: Matches }, { ...caller, signal })).value
      .matches;
}

/** Most subtitle lines shown with one window; a dense film at an unknown speed could offer more. */
const MAX_LINES = 300;
/** Requests at once when the caller does not say: a local model server is usually one GPU or CPU. */
export const CONCURRENCY = { local: 3 } as const;

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
