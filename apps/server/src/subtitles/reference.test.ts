import { readFileSync } from 'node:fs';
import { SyncCore } from '@paiban/shared';
import { describe, expect, it } from 'vitest';
import { sameLanguagePairs } from '../asr/align.js';
import { computeReferenceAlignment } from './align.js';
import { extraLines, referenceLines, referenceOffBy, referenceSpeech, referenceTranscript } from './reference.js';

type Cue = SyncCore.Cue;

/**
 * Aligning one subtitle to another (docs/08, "Align by other subtitles") on the 21.5-minute synthetic film:
 * `truth` plays as the reference, aligned; the other subtitle is wrong in the usual ways and also
 * carries the things real subtitles do: credits at the start, lines split or joined differently.
 */
const film = JSON.parse(readFileSync(new URL('../../../../fixtures/film/film.json', import.meta.url), 'utf8')) as {
  speech: SyncCore.SpeechData;
  truth: Cue[];
  late: Cue[];
  pal: Cue[];
  cut: Cue[];
};
const ref = { subtitleId: 'ref', lines: referenceLines(film.truth, SyncCore.identityDoc()) };

/** Renumbers in time order, as cues.json is. */
const renumber = (cues: Cue[]): Cue[] => cues.sort((a, b) => a.start - b.start).map((c, i) => ({ ...c, id: i + 1 }));

/** Two credit lines before the film starts, in the subtitle's own (wrong) timeline. */
const withCredits = (cues: Cue[]): Cue[] =>
  renumber([
    { id: 0, start: 1, end: 4, text: 'Subtitles by the Paiban Team' },
    { id: 0, start: 4.5, end: 7, text: 'www.example-subs.com' },
    ...cues.map((c) => ({ ...c })),
  ]);

/** Every line split into two halves, in time and text: one line here is two there. */
const split = (cues: Cue[]): Cue[] =>
  renumber(
    cues.flatMap((c) => {
      const mid = (c.start + c.end) / 2;
      const words = c.text.split(' ');
      const h = Math.ceil(words.length / 2);
      return [
        { id: 0, start: c.start, end: mid, text: words.slice(0, h).join(' ') },
        { id: 0, start: mid + 0.05, end: c.end, text: words.slice(h).join(' ') || '…' },
      ];
    }),
  );

/** Every two lines joined into one: two lines here are one there. */
const joined = (cues: Cue[]): Cue[] =>
  renumber(
    cues.flatMap((c, i) => {
      if (i % 2) return [];
      const n = cues[i + 1];
      return [n ? { id: 0, start: c.start, end: n.end, text: `${c.text}\n${n.text}` } : { ...c }];
    }),
  );

/** In another language: same timing, words nobody can match. */
const foreign = (cues: Cue[]): Cue[] => cues.map((c, i) => ({ ...c, text: `第 ${i + 1} 句的台詞` }));

/** Largest error of where the alignment puts each line against the truth line it came from. */
function maxError(cues: Cue[], segments: SyncCore.Segment[], truthStart: (c: Cue) => number | null): number {
  const mapped = SyncCore.applyDoc(cues, { segments, edits: {} });
  let worst = 0;
  cues.forEach((c, i) => {
    const want = truthStart(c);
    if (want !== null) worst = Math.max(worst, Math.abs((mapped[i]?.start ?? 0) - want));
  });
  return worst;
}

describe('the reference as the film', () => {
  it('turns lines into speech spans, merging overlaps, and splits them into windows', () => {
    const sp = referenceSpeech([
      { start: 1, end: 2, text: 'a' },
      { start: 1.5, end: 3, text: 'b' },
      { start: 5, end: 6, text: 'c' },
    ]);
    expect(sp.segments).toEqual([
      [100, 300],
      [500, 600],
    ]);
    const tr = referenceTranscript(ref.lines, 'en-US', 20);
    expect(tr.language).toBe('en');
    expect(tr.windows.length).toBe(Math.ceil(ref.lines.length / 20));
    const counted = tr.windows.map(([s, d]) => tr.segments.filter((x) => x.start >= s && x.start < s + d).length);
    expect(counted.reduce((a, b) => a + b, 0)).toBe(ref.lines.length);
  });
});

describe('aligning to the reference', () => {
  it('another language, nothing paired: the timing of the reference finds speed and offset, despite credits', () => {
    const target = withCredits(foreign(film.pal));
    const r = computeReferenceAlignment(ref, target, { allowSplit: true });
    expect(r.method).toBe('reference');
    expect(r.reference).toMatchObject({ via: 'timing', pairs: 0 });
    expect(r.segments).toHaveLength(1);
    const truthStart = (c: Cue) => {
      const i = film.pal.findIndex((p) => Math.abs(p.start - c.start) < 1e-9);
      return i >= 0 ? (film.truth[i]?.start ?? null) : null;
    };
    expect(maxError(target, r.segments, truthStart)).toBeLessThan(0.2);
    expect(r.extraLines).toEqual([1, 2]);
  });

  it('a cut: two parts, found from the reference alone', () => {
    // In the fixture's own order: the cut puts part two's times before part one's end.
    const target = foreign(film.cut);
    const r = computeReferenceAlignment(ref, target, { allowSplit: true });
    expect(r.segments).toHaveLength(2);
    const truthStart = (c: Cue) => {
      const i = film.cut.findIndex((p) => Math.abs(p.start - c.start) < 1e-9);
      return i >= 0 ? (film.truth[i]?.start ?? null) : null;
    };
    expect(maxError(target, r.segments, truthStart)).toBeLessThan(0.2);
  });

  it('one line here, two there: split lines still land on the reference', () => {
    const late = split(film.late);
    const r = computeReferenceAlignment(ref, late, { allowSplit: true });
    expect(r.segments).toHaveLength(1);
    expect(Math.abs((r.segments[0]?.offset ?? 0) + 2.37)).toBeLessThan(0.15);
  });

  it('two lines here, one there, same language: paired by text, credits offered for deletion', () => {
    const target = withCredits(joined(film.late));
    const pairs = sameLanguagePairs(target, referenceTranscript(ref.lines, 'en'));
    expect(pairs.length).toBeGreaterThan(40);
    const r = computeReferenceAlignment(ref, target, {
      allowSplit: true,
      pairs: { language: 'en', pairs, via: 'text', llmError: null },
      filmSpeech: film.speech,
    });
    expect(r.method).toBe('reference-text');
    expect(r.reference).toMatchObject({ via: 'text' });
    expect(r.reference?.support).toBeGreaterThan(30);
    expect(Math.abs((r.segments[0]?.offset ?? 0) + 2.37)).toBeLessThan(0.15);
    expect(r.extraLines).toEqual([1, 2]);
    // Scored against the film's own speech, like any alignment.
    expect(r.score).toBeGreaterThan(r.scoreBefore);
  });

  it('says when the reference itself is off from the film, and follows it anyway', () => {
    const lateRef = referenceLines(film.late, SyncCore.identityDoc());
    expect(referenceOffBy(film.speech, ref.lines, 60)).toBeNull();
    expect(referenceOffBy(film.speech, lateRef, 60)).toBeCloseTo(2.4, 0);
    const r = computeReferenceAlignment({ subtitleId: 'late', lines: lateRef }, foreign(film.truth), {
      allowSplit: false,
      filmSpeech: film.speech,
    });
    expect(r.reference?.offBy).toBeCloseTo(2.4, 0);
    expect(Math.abs((r.segments[0]?.offset ?? 0) - 2.37)).toBeLessThan(0.15);
    // Without the film's speech there is nothing to check against.
    expect(computeReferenceAlignment(ref, foreign(film.late), { allowSplit: false }).reference?.offBy).toBeNull();
  });

  it('offers nothing for deletion when every line has its place', () => {
    const r = computeReferenceAlignment(ref, foreign(film.late), { allowSplit: false });
    expect(r.extraLines).toEqual([]);
    expect(extraLines(film.truth, [{ from: 0, scale: 1, offset: 0 }], ref.lines)).toEqual([]);
  });
});
