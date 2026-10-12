import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AlignResult, Lang, LlmErrorCode, SyncCore } from '@paiban/shared';
import type { Deps } from '../http/context.js';
import type { LlmPool } from '../llm/pool.js';
import { toTraditional } from '../subtitles/text.js';
import type { Pair } from './fit.js';
import { LlmError, llmPairs, poolMatcher } from './llm.js';
import { type AsrTranscript, textPairs } from './text.js';

type Cue = SyncCore.Cue;

/** Pairs handed to the alignment, and how they were made. */
export type HeardPairs = {
  language: string;
  pairs: Pair[];
  /** When each recognised line starts: where recognition listened and heard something. */
  heardAt?: number[];
  via: 'text' | 'llm' | 'none';
  llmError: LlmErrorCode | null;
};
export type Heard = NonNullable<AlignResult['heard']>;

/** media/<id>/asr.json, or null when recognition has not run (or its file is unreadable). */
export async function readTranscript(dataDir: string, mediaId: string): Promise<AsrTranscript | null> {
  try {
    return JSON.parse(await readFile(join(dataDir, 'media', mediaId, 'asr.json'), 'utf8')) as AsrTranscript;
  } catch {
    return null;
  }
}

/** Whether a subtitle is in the language recognition heard: 'zh-Hant' and 'zh' both match Whisper's 'zh'. */
export function sameLanguage(subtitle: Lang | string, heard: string): boolean {
  return subtitle.split('-')[0].toLowerCase() === heard.toLowerCase();
}

/**
 * Pairs by text for a subtitle in the spoken language. Whisper writes Chinese in either script;
 * both sides are brought to Traditional characters first so the same word compares equal.
 */
export function sameLanguagePairs(cues: readonly Cue[], transcript: AsrTranscript): Pair[] {
  if (transcript.language !== 'zh') return textPairs(cues, transcript);
  const tw = (t: string) => toTraditional(t, 'tw');
  return textPairs(
    cues.map((c) => ({ ...c, text: tw(c.text) })),
    { ...transcript, segments: transcript.segments.map((s) => ({ ...s, text: tw(s.text) })) },
  );
}

/** Same-language pairs, or none (a language model is only asked by the api, which holds the key). */
export function localPairs(
  cues: readonly Cue[],
  transcript: AsrTranscript | null,
  language: string,
): HeardPairs | null {
  if (!transcript) return null;
  const heardAt = transcript.segments.map((s) => s.start);
  if (!sameLanguage(language, transcript.language))
    return { language: transcript.language, pairs: [], heardAt, via: 'none', llmError: null };
  return {
    language: transcript.language,
    pairs: sameLanguagePairs(cues, transcript),
    heardAt,
    via: 'text',
    llmError: null,
  };
}

/** How long the api spends asking the model before it hands the alignment to the media service. */
export const LLM_BUDGET_MS = 45_000;

/**
 * Pairs through the language model for a subtitle in another language than the one spoken
 * (docs/08, "Language model"). Runs in the api, the only service that holds keys; the model is whichever
 * LLM profile the pool picks (docs/18-llm.md). Null when there is nothing to ask: no recognition,
 * the same language (the media service pairs by text), or no profile set up. A failure is
 * reported in `llmError` and the alignment goes on without pairs.
 */
export async function llmHeard(
  deps: Pick<Deps, 'pool' | 'config' | 'log'>,
  llm: LlmPool,
  mediaId: string,
  cues: readonly Cue[],
  language: string,
  userId: string | null = null,
): Promise<HeardPairs | null> {
  if (!(await llm.hasProfiles())) return null;
  const transcript = await readTranscript(deps.config.dataDir, mediaId);
  if (!transcript || sameLanguage(language, transcript.language)) return null;
  const started = Date.now();
  try {
    const r = await llmPairs(
      poolMatcher(llm, { purpose: 'align', userId }),
      cues,
      transcript,
      language,
      AbortSignal.timeout(LLM_BUDGET_MS),
      await llm.capacity(),
    );
    deps.log.info(
      { mediaId, pairs: r.pairs.length, failedWindows: r.failed, ms: Date.now() - started },
      'language model paired recognised speech',
    );
    return {
      language: transcript.language,
      pairs: r.pairs,
      heardAt: transcript.segments.map((s) => s.start),
      via: 'llm',
      llmError: null,
    };
  } catch (err) {
    const code: LlmErrorCode =
      err instanceof LlmError
        ? err.code
        : err instanceof Error && /abort|timeout/i.test(err.name)
          ? 'TIMEOUT'
          : 'BAD_RESPONSE';
    deps.log.warn({ mediaId, code, ms: Date.now() - started }, 'language model pairing failed');
    return { language: transcript.language, pairs: [], via: 'none', llmError: code };
  }
}
