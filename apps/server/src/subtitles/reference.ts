import { type SpeechData, SyncCore, type SyncDoc } from '@paiban/shared';
import type { AsrTranscript } from '../asr/text.js';

type Cue = SyncCore.Cue;
type Segment = SyncCore.Segment;

/**
 * Aligning a subtitle to another one already aligned (Brian, 2026-10-06; docs/08, "依另一條字幕
 * 對齊"). The reference stands in for the film: its lines, as they play now, are where people
 * speak, far more precisely than speech detection can tell, and its words can be paired with the
 * other subtitle's by text (same language) or by the language model (another language).
 */
export type RefLine = { start: number; end: number; text: string };

/** The reference's lines as they play: segments and edits applied, deleted lines left out, in time order. */
export function referenceLines(cues: readonly Cue[], doc: Pick<SyncDoc, 'segments' | 'edits'>): RefLine[] {
  return SyncCore.applyDoc(cues, doc)
    .filter((m) => !m.deleted && m.text.trim())
    .map((m) => ({ start: m.start, end: m.end, text: m.text }))
    .sort((a, b) => a.start - b.start);
}

/**
 * The reference as a speech track: one interval per line, overlaps merged, at the 100 Hz the
 * alignment scores with. A line split in two in one subtitle and kept whole in the other covers
 * the same span either way, so the split does not matter here.
 */
export function referenceSpeech(lines: readonly RefLine[], hz = 100): SpeechData {
  const segs: [number, number][] = [];
  for (const l of lines) {
    const a = Math.max(0, Math.round(l.start * hz));
    const b = Math.max(a + 1, Math.round(l.end * hz));
    const last = segs[segs.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else segs.push([a, b]);
  }
  const frames = (segs[segs.length - 1]?.[1] ?? 0) + hz;
  return { hz, frames, segments: segs };
}

/** "zh-Hant" → "zh": the part the pairing compares languages by. */
export const baseLanguage = (lang: string) => lang.split('-')[0]?.toLowerCase() ?? lang;

/**
 * The reference's lines in the shape speech recognition produces, so the same pairing applies:
 * by text, or through the language model one window of `perWindow` lines at a time.
 */
export function referenceTranscript(lines: readonly RefLine[], language: string, perWindow = 20): AsrTranscript {
  const windows: [number, number][] = [];
  for (let i = 0; i < lines.length; i += perWindow) {
    const group = lines.slice(i, i + perWindow);
    const first = group[0];
    const last = group[group.length - 1];
    if (!first || !last) continue;
    // Half-open windows that touch: every line falls in exactly one.
    const next = lines[i + perWindow];
    const start = first.start;
    const end = next ? next.start : last.end + 1;
    windows.push([start, Math.max(0.5, end - start)]);
  }
  return {
    language: baseLanguage(language),
    model: 'reference',
    windows,
    segments: lines.map((l) => ({ start: l.start, end: l.end, text: l.text })),
  };
}

/** Moving this far to fit the film's speech, the reference is off. */
const OFF_SECONDS = 1;
/** And the fit has to improve at least this much, so a film with unclear speech does not raise alarms. */
const OFF_GAIN = 0.03;

/**
 * How far the reference itself is from the film's detected speech, when it clearly is (more than
 * a second, with a real gain in fit); null when it fits. A reference marked confirmed can still be
 * wrong, and everything aligned to it would be wrong the same way.
 */
export function referenceOffBy(film: SpeechData, lines: readonly RefLine[], radius: number): number | null {
  if (lines.length < 8) return null;
  const sp = SyncCore.makeSpeech(film);
  const cues: Cue[] = lines.map((l, i) => ({ id: i + 1, start: l.start, end: l.end, text: l.text }));
  const seg = SyncCore.autoAlign(sp, cues, { allowSplit: false, radius }).segments[0];
  if (!seg) return null;
  const moved = SyncCore.applyDoc(cues, { segments: [seg], edits: {} });
  const off = Math.max(...cues.map((c, i) => Math.abs((moved[i]?.start ?? c.start) - c.start)));
  const gain =
    SyncCore.totalScore(sp, moved) - SyncCore.totalScore(sp, SyncCore.applyDoc(cues, SyncCore.identityDoc()));
  return off > OFF_SECONDS && gain > OFF_GAIN ? Math.round(off * 10) / 10 : null;
}

/** Words that give away a line about the subtitle rather than the film. */
const CREDITS =
  /(https?:\/\/|www\.|\.(com|net|org|tv|cc|io)\b|@|字幕|翻譯|翻译|校對|校对|時間軸|时间轴|压制|壓制|片源|subtitle|subbed|subs by|synced|sync by|resync|corrected by|opensubtitles|subscene|addic7ed|podnapisi|yify|yts\b|rarbg|advertise|support us|become a vip)/i;

/** How many lines at each end are looked at. Credits are never in the middle of a film. */
const EDGE = 10;

/** Indexes of the lines at either end that read like credits: left out while aligning. */
export function creditIndexes(cues: readonly Cue[]): Set<number> {
  const out = new Set<number>();
  const n = cues.length;
  for (let i = 0; i < n; i++) {
    if (i >= EDGE && i < n - EDGE) continue;
    if (CREDITS.test(cues[i]?.text ?? '')) out.add(i);
  }
  return out;
}

/** Fewer lines than this in a segment at either end, and it is credits or noise, not part of the film. */
const MIN_EDGE_SEGMENT = 4;

/**
 * Folds a segment at the start or end that covers only a few lines into its neighbour: a cut
 * that close to an end, that short, is credits or noise, and the reference is precise enough
 * not to need one.
 */
export function foldEdgeSegments(segments: readonly Segment[], count: number): Segment[] {
  let out = segments.map((s) => ({ ...s }));
  while (out.length > 1) {
    const second = out[1];
    if (second && second.from < MIN_EDGE_SEGMENT) {
      out = [{ ...second, from: 0 }, ...out.slice(2)];
      continue;
    }
    const last = out[out.length - 1];
    if (last && count - last.from < MIN_EDGE_SEGMENT) {
      out = out.slice(0, -1);
      continue;
    }
    break;
  }
  return out;
}

/**
 * Lines at the start or end of the aligned subtitle that the reference has nothing for, and that
 * read like credits ("Subtitles by…", a website) or sit far from every line of the reference.
 * Offered for deletion; never deleted without the person saying so. Returns cue ids.
 */
export function extraLines(cues: readonly Cue[], segments: readonly Segment[], ref: readonly RefLine[]): number[] {
  if (!ref.length) return [];
  const sorted = ref.map((l) => l.start);
  const near = (a: number, b: number) => ref.some((l) => l.start < b + 1 && l.end > a - 1); // any reference line within a second
  const distance = (t: number) => {
    let best = Number.POSITIVE_INFINITY;
    for (const s of sorted) best = Math.min(best, Math.abs(s - t));
    return best;
  };
  const out: number[] = [];
  const check = (i: number) => {
    const c = cues[i];
    if (!c) return;
    const s = segments[SyncCore.segmentIndex({ segments: segments as Segment[] }, i)];
    if (!s) return;
    const a = c.start * s.scale + s.offset;
    const b = c.end * s.scale + s.offset;
    if (near(a, b)) return;
    if (CREDITS.test(c.text) || distance(a) > 20) out.push(c.id);
  };
  for (let i = 0; i < Math.min(EDGE, cues.length); i++) check(i);
  for (let i = Math.max(EDGE, cues.length - EDGE); i < cues.length; i++) check(i);
  return out;
}
