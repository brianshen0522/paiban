import { SyncCore } from '@paiban/shared';
import type { Pair } from './fit.js';

type Cue = SyncCore.Cue;

/** One recognised sentence: film time, and what was said. */
export type AsrSegment = { start: number; end: number; text: string };
export type AsrWindow = [start: number, duration: number];
/** media/<id>/asr.json: what speech recognition heard in a few windows of the film. */
export type AsrTranscript = { language: string; model: string; windows: AsrWindow[]; segments: AsrSegment[] };

/**
 * The widest gap between a subtitle's own times and the film that pairing still looks across:
 * the largest shift the other engines search (60 s) with room to spare, at any known speed.
 */
export const MAX_SHIFT = 90;
const MIN_SCALE = Math.min(...SyncCore.RATES.map((r) => r.scale));
const MAX_SCALE = Math.max(...SyncCore.RATES.map((r) => r.scale));

/** Original subtitle times that could end up at film time `from`..`to`. */
export function sourceRange(from: number, to: number): [number, number] {
  return [(from - MAX_SHIFT) / MAX_SCALE, (to + MAX_SHIFT) / MIN_SCALE];
}

/** Indexes of the cues whose start lies in [lo, hi]; the cue list is in time order. */
export function cuesBetween(cues: ReadonlyArray<Cue>, lo: number, hi: number): number[] {
  let a = 0;
  let b = cues.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (cues[m].start < lo) a = m + 1;
    else b = m;
  }
  const out: number[] = [];
  for (let i = a; i < cues.length && cues[i].start <= hi; i++) out.push(i);
  return out;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Words to compare: markup and punctuation gone, case folded, full-width forms narrowed. Text
 * in Chinese, Japanese or Korean script is compared character by character, since it has no
 * spaces between words.
 */
export function tokens(text: string): string[] {
  const plain = text
    .normalize('NFKC')
    .replace(/<[^>]*>|\{[^}]*\}/g, ' ')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ');
  const out: string[] = [];
  for (const word of plain.split(/\s+/)) {
    if (!word) continue;
    if (CJK.test(word)) {
      for (const ch of word) out.push(ch);
    } else out.push(word);
  }
  return out;
}

/**
 * How much of two token lists is the same, 0 to 1: shared tokens over the length of the
 * shorter list, but only when the shorter one is at least half the longer one. A subtitle line
 * often holds one sentence of a recognised line or the other way round; a two-word line that
 * happens to share both words with a long one is not a match.
 */
export function similarity(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (!a.length || !b.length) return 0;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length * 2 < long.length) return 0;
  return covered(short, long);
}

/** The share of `part`'s tokens that also occur in `whole`, each occurrence used once. */
export function covered(part: ReadonlyArray<string>, whole: ReadonlyArray<string>): number {
  if (!part.length) return 0;
  const counts = new Map<string, number>();
  for (const t of whole) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of part) {
    const n = counts.get(t) ?? 0;
    if (n > 0) {
      shared++;
      counts.set(t, n - 1);
    }
  }
  return shared / part.length;
}

/** Below this many tokens a line ("yes", "come on") matches too many others to tell anything. */
const MIN_TOKENS = 3;
const MIN_SIMILARITY = 0.6;
const MIN_LEAD = 0.15;
/** Recognised sentences closer than this belong to one stretch of talk and may be read together. */
const JOIN_GAP = 2;

/**
 * Pairs by plain text comparison, for a subtitle in the language that was spoken. A subtitle
 * line often holds two or three short sentences, and recognition sometimes splits one line in
 * two, so runs of up to three recognised sentences are compared with runs of up to two cues
 * that could be at that time. A run is paired by its first sentence and first cue when the
 * best comparison is similar enough and clearly better than any other place in the subtitle.
 * A cue keeps only its best partner. No language model is involved.
 */
export function textPairs(cues: ReadonlyArray<Cue>, transcript: AsrTranscript): Pair[] {
  const cueTokens = cues.map((c) => tokens(c.text));
  const heard = transcript.segments.map((s) => tokens(s.text));
  const byCue = new Map<number, { y: number; score: number }>();
  const segs = transcript.segments;
  for (let k = 0; k < segs.length; k++) {
    const [lo, hi] = sourceRange(segs[k].start, segs[k].start);
    const near = cuesBetween(cues, lo, hi);
    let best = { cue: -1, score: 0 };
    const scoreAt = new Map<number, number>();
    let run: string[] = [];
    for (let len = 1; len <= 3 && k + len - 1 < segs.length; len++) {
      const j = k + len - 1;
      if (len > 1 && segs[j].start - segs[j - 1].end > JOIN_GAP) break;
      run = run.concat(heard[j]);
      if (run.length < MIN_TOKENS) continue;
      for (const i of near) {
        let cueRun = cueTokens[i];
        for (let m = 1; m <= 2 && i + m - 1 < cues.length; m++) {
          if (m === 2) cueRun = cueRun.concat(cueTokens[i + 1]);
          if (cueRun.length < MIN_TOKENS) continue;
          // A joined run is paired by its first sentence and first cue, so both have to be in it.
          if (len > 1 && covered(heard[k], cueRun) < 0.5) continue;
          if (m > 1 && covered(cueTokens[i], run) < 0.5) continue;
          // The pair's time is where the run starts, so the cue has to start with it too.
          if (covered(cueRun.slice(0, 3), run) < 0.6 || covered(run.slice(0, 3), cueRun) < 0.6) continue;
          const sc = similarity(run, cueRun);
          scoreAt.set(i, Math.max(scoreAt.get(i) ?? 0, sc));
          if (sc > best.score) best = { cue: i, score: sc };
        }
      }
    }
    if (best.cue < 0 || best.score < MIN_SIMILARITY) continue;
    // Somewhere else in the subtitle that fits nearly as well makes this one a guess.
    let second = 0;
    for (const [i, sc] of scoreAt) if (Math.abs(i - best.cue) > 1) second = Math.max(second, sc);
    if (best.score - second < MIN_LEAD) continue;
    const prev = byCue.get(best.cue);
    if (!prev || prev.score < best.score) byCue.set(best.cue, { y: segs[k].start, score: best.score });
  }
  return [...byCue.entries()].map(([cue, v]) => ({ cue, y: v.y }));
}

/** Most listening per film: a long film is sampled, never decoded whole. */
export const MAX_LISTEN_SECONDS = 360;

/**
 * Where to listen: windows of `length` seconds spread evenly over the film, one in the middle
 * of each equal part. Together they cover 40 % of a short film and at most six minutes of a
 * long one (docs/08-media-pipeline.md, "語音辨識"). The detected speech is deliberately not
 * used to place them: on films with a lot of music it points at the music.
 */
export function pickWindows(duration: number, length = 30): AsrWindow[] {
  if (!(duration > 1)) return [];
  if (duration <= length * 2) return [[0, Math.floor(duration)]];
  const count = Math.max(2, Math.min(12, Math.round(Math.min(MAX_LISTEN_SECONDS, duration * 0.4) / length)));
  const part = duration / count;
  const out: AsrWindow[] = [];
  for (let k = 0; k < count; k++) out.push([Math.round((k * part + (part - length) / 2) * 10) / 10, length]);
  return out;
}
