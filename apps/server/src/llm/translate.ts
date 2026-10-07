import { z } from 'zod';
import type { JsonRequest } from './providers.js';

/**
 * Translating a subtitle with a language model (docs/18-llm.md, "字幕翻譯"): the film's
 * background, then 50 lines at a time with up to 10 earlier lines (and their translations) and 10
 * later lines as context the model is told not to translate. Chunks go in order, so names and
 * wording carry from one to the next. This file builds the questions and checks the answers;
 * worker.ts runs them.
 */
export const CHUNK = 50;
export const BEFORE = 10;
export const AFTER = 10;

export type Film = {
  title: string;
  titleZh: string | null;
  year: number;
  genres: string[];
  overview: string;
};

export const Answer = z.object({
  lines: z.array(z.object({ id: z.number().int(), text: z.string() })),
});
export type Answer = z.infer<typeof Answer>;

/** [first, end) of each chunk over `n` lines. */
export function chunks(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let a = 0; a < n; a += CHUNK) out.push([a, Math.min(n, a + CHUNK)]);
  return out;
}

/** "Japanese (ja)", "Traditional Chinese, as written in Taiwan (zh-Hant)": what the model is told to write. */
export function languageName(code: string): string {
  if (code === 'zh-Hant' || code === 'zh-TW') return 'Traditional Chinese as used in Taiwan (zh-Hant)';
  if (code === 'zh-Hans' || code === 'zh-CN') return 'Simplified Chinese as used in mainland China (zh-Hans)';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** Taiwan's words and punctuation for Traditional Chinese, which models otherwise mix with mainland usage. */
const TAIWAN =
  'Use Taiwanese vocabulary and phrasing (for example 影片 not 视频/視頻, 軟體 not 軟件, 計程車 not 出租車, 資訊 not 信息), full-width punctuation, and 「」 for quotes.';

export function system(target: string): string {
  return [
    `You translate film subtitles into ${languageName(target)}.`,
    'Each line is shown on screen while someone speaks, so keep translations short, natural and spoken, the way a professional subtitler would; keep the meaning, tone and register, not the word order.',
    'Keep names, places and terms consistent with the earlier lines and their translations.',
    'A line may contain a line break, written as \\n; keep at most two short lines.',
    'Lines marked as context are there only to help you understand; never translate or return them.',
    'Song lyrics and sound descriptions (♪, [door slams]) are translated too; keep the symbols.',
    ...(target === 'zh-Hant' || target === 'zh-TW' ? [TAIWAN] : []),
    'Answer with JSON only: {"lines": [{"id": <id>, "text": "<translation>"}, ...]}, one entry for every line to translate, with its id, in order. Nothing else.',
  ].join('\n');
}

const show = (s: string) => JSON.stringify(s.replace(/\r/g, ''));

/**
 * The question for one chunk: lines [a, b) to translate, the 10 before (with translations, once
 * they exist) and the 10 after as context. Ids are the lines' positions in the subtitle, from 1.
 */
export function question(
  film: Film,
  target: string,
  texts: readonly string[],
  done: readonly (string | null)[],
  [a, b]: [number, number],
): { system: string; user: string; ids: number[] } {
  const parts: string[] = [];
  const title = film.titleZh && film.titleZh !== film.title ? `${film.title} (${film.titleZh})` : film.title;
  parts.push(`Film: ${title}, ${film.year}${film.genres.length ? `. Genres: ${film.genres.join(', ')}` : ''}.`);
  if (film.overview.trim()) parts.push(`Synopsis: ${film.overview.trim()}`);
  const before = Array.from({ length: Math.min(BEFORE, a) }, (_, k) => a - Math.min(BEFORE, a) + k);
  if (before.length) {
    parts.push('', 'Earlier lines, for context only (do not translate or return them):');
    for (const i of before) {
      const t = done[i];
      parts.push(`${i + 1}: ${show(texts[i] ?? '')}${t ? ` => ${show(t)}` : ''}`);
    }
  }
  parts.push('', 'Translate these lines:');
  const ids: number[] = [];
  for (let i = a; i < b; i++) {
    ids.push(i + 1);
    parts.push(`${i + 1}: ${show(texts[i] ?? '')}`);
  }
  const after = Array.from({ length: Math.min(AFTER, texts.length - b) }, (_, k) => b + k);
  if (after.length) {
    parts.push('', 'Later lines, for context only (do not translate or return them):');
    for (const i of after) parts.push(`${i + 1}: ${show(texts[i] ?? '')}`);
  }
  parts.push('', `Return exactly ${ids.length} lines, ids ${ids[0]} to ${ids[ids.length - 1]}.`);
  return { system: system(target), user: parts.join('\n'), ids };
}

/**
 * The translations of a chunk in id order, or null when the answer does not cover exactly the
 * lines asked: a missing, extra, repeated or empty line means the chunk is asked again.
 */
export function readAnswer(answer: Answer, ids: readonly number[]): string[] | null {
  if (answer.lines.length !== ids.length) return null;
  const byId = new Map<number, string>();
  for (const l of answer.lines) {
    if (byId.has(l.id)) return null;
    byId.set(l.id, l.text);
  }
  const out: string[] = [];
  for (const id of ids) {
    const t = byId.get(id)?.replace(/\\n/g, '\n').replace(/\r/g, '').trim();
    if (!t) return null;
    out.push(t);
  }
  return out;
}

/** The subtitle line as written: the translation, or (bilingual) the translation over the original. */
export function lineText(translation: string, original: string, mode: 'plain' | 'bilingual'): string {
  return mode === 'bilingual' ? `${translation}\n${original.trim()}` : translation;
}

/** The test button's question: two English lines into Traditional Chinese; the reply when both came back translated. */
export function testQuestion(): { request: JsonRequest<Answer>; check: (a: Answer) => string | null } {
  const film: Film = { title: 'Test', titleZh: null, year: 2026, genres: [], overview: '' };
  const q = question(film, 'zh-Hant', ['Where did you put the keys?', 'On the kitchen table.'], [], [0, 2]);
  return {
    request: { system: q.system, user: q.user, schema: Answer },
    check: (a) => {
      const lines = readAnswer(a, q.ids);
      return lines?.every((l) => /[㐀-鿿]/.test(l)) ? lines.join('／') : null;
    },
  };
}
