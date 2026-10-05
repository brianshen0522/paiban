import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AlignResult, Lang, SyncCore } from '@paiban/shared';
import type { Deps } from '../http/context.js';
import { readSecret } from '../settings/secrets.js';
import { readSettings } from '../settings/settings.js';
import { toTraditional } from '../subtitles/text.js';
import type { Pair } from './fit.js';
import {
  anthropicMatcher,
  DEFAULT_ANTHROPIC_MODEL,
  LlmError,
  type LlmErrorCode,
  llmPairs,
  openAiCompatibleMatcher,
} from './llm.js';
import { type AsrTranscript, textPairs } from './text.js';

type Cue = SyncCore.Cue;

/** Pairs handed to the alignment, and how they were made. */
export type HeardPairs = {
  language: string;
  pairs: Pair[];
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
  if (!sameLanguage(language, transcript.language))
    return { language: transcript.language, pairs: [], via: 'none', llmError: null };
  return { language: transcript.language, pairs: sameLanguagePairs(cues, transcript), via: 'text', llmError: null };
}

/** How long the api spends asking the model before it hands the alignment to the media service. */
export const LLM_BUDGET_MS = 45_000;

/**
 * Pairs through the language model for a subtitle in another language than the one spoken
 * (docs/08, "語言模型"). Runs in the api, the only service that holds keys. Null when there is
 * nothing to ask: no recognition, the same language (the media service pairs by text), or no
 * model configured. A failure is reported in `llmError` and the alignment goes on without pairs.
 */
export async function llmHeard(
  deps: Pick<Deps, 'pool' | 'config' | 'log'>,
  mediaId: string,
  cues: readonly Cue[],
  language: string,
): Promise<HeardPairs | null> {
  const { llm } = (await readSettings(deps.pool)).align;
  if (llm.provider === 'none') return null;
  const transcript = await readTranscript(deps.config.dataDir, mediaId);
  if (!transcript || sameLanguage(language, transcript.language)) return null;
  const none = (llmError: LlmErrorCode): HeardPairs => ({
    language: transcript.language,
    pairs: [],
    via: 'none',
    llmError,
  });
  const key = await readSecret(deps, 'llmKey');
  if (llm.provider === 'anthropic' && !key) return none('NOT_CONFIGURED');
  const matcher =
    llm.provider === 'anthropic'
      ? anthropicMatcher(key ?? '', llm.model || DEFAULT_ANTHROPIC_MODEL)
      : openAiCompatibleMatcher(llm.baseUrl, key, llm.model, LLM_BUDGET_MS);
  const started = Date.now();
  try {
    const r = await llmPairs(matcher, cues, transcript, language, AbortSignal.timeout(LLM_BUDGET_MS));
    deps.log.info(
      { mediaId, provider: llm.provider, pairs: r.pairs.length, failedWindows: r.failed, ms: Date.now() - started },
      'language model paired recognised speech',
    );
    return { language: transcript.language, pairs: r.pairs, via: 'llm', llmError: null };
  } catch (err) {
    const code: LlmErrorCode =
      err instanceof LlmError
        ? err.code
        : err instanceof Error && /abort|timeout/i.test(err.name)
          ? 'TIMEOUT'
          : 'BAD_RESPONSE';
    deps.log.warn({ mediaId, provider: llm.provider, code, ms: Date.now() - started }, 'language model pairing failed');
    return none(code);
  }
}
