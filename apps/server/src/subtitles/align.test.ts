import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeAlignment, ffsubsyncCandidates, probeSrt, startsFromOutput } from './align.js';
import { normalizeCues, parseSrt } from './text.js';

/**
 * The last column of the table in docs/08-media-pipeline.md ("Results on the test fixtures"), from the recorded
 * ffsubsync outputs in fixtures/ffsubsync, so it runs without ffsubsync. The image test runs the
 * real tool end to end (test/subtitles-align.test.ts).
 */
const read = (p: string) => readFileSync(fileURLToPath(new URL(`../../../../fixtures/${p}`, import.meta.url)), 'utf8');
const data = JSON.parse(read('data.json')) as { speechFrames: number; speech: [number, number][] };
const speech = { hz: 100, frames: data.speechFrames, segments: data.speech };
const cues = (name: string) => normalizeCues(parseSrt(read(`${name}.zh-TW.srt`)));

const EXPECTED = {
  late: [{ scale: 1, offset: -2.36 }],
  rate: [{ scale: 1.04271, offset: -0.79 }],
  cut: [
    { scale: 1, offset: 1.25 },
    { scale: 1, offset: 13.24 },
  ],
} as const;

describe('computeAlignment', () => {
  it.each(['late', 'rate', 'cut'] as const)('%s matches the table in docs/08', (name) => {
    const base = cues(name);
    const extra = ffsubsyncCandidates(speech, base, {
      linear: read(`ffsubsync/${name}.linear.out.srt`),
      split: read(`ffsubsync/${name}.split.out.srt`),
    });
    expect(extra.map((c) => c.method)).toEqual(['ffsubsync-linear', 'ffsubsync-split']);
    const r = computeAlignment(speech, base, { allowSplit: true }, extra);
    expect(r.segments.length).toBe(EXPECTED[name].length);
    r.segments.forEach((s, i) => {
      expect(Math.abs(s.scale - EXPECTED[name][i].scale), `${name} scale`).toBeLessThan(0.00001);
      expect(Math.abs(s.offset - EXPECTED[name][i].offset), `${name} offset`).toBeLessThanOrEqual(0.01);
    });
    expect(r.agree).toBe(true);
    expect(r.score).toBeGreaterThan(r.scoreBefore);
    expect(Math.abs(r.score - 0.796)).toBeLessThan(0.01);
  });

  it('still answers with the core alone, and one segment when splitting is not allowed', () => {
    const r = computeAlignment(speech, cues('cut'), { allowSplit: false });
    expect(r.method).toBe('core');
    expect(r.segments.length).toBe(1);
    expect(r.agree).toBe(false);
  });

  it('scores "before" against the document it is given', () => {
    const base = cues('late');
    const fixed = computeAlignment(speech, base, {
      allowSplit: false,
      before: { segments: [{ from: 0, scale: 1, offset: -2.36 }], edits: {} },
    });
    expect(fixed.scoreBefore).toBeGreaterThan(0.75);
  });
});

describe('ffsubsync output', () => {
  it('matches back by the #id markers our input carries, and refuses a run that lost a cue', () => {
    const base = cues('late');
    const echoed = probeSrt(base.map((c) => ({ ...c, start: c.start - 2, end: c.end - 2 })));
    expect(probeSrt(base)).not.toContain(base[0]?.text);
    expect(startsFromOutput(base, echoed)).toEqual(base.map((c) => Math.round((c.start - 2) * 1000) / 1000));
    const missing = echoed.split('\n\n').slice(1).join('\n\n');
    expect(startsFromOutput(base, missing)).toBeNull();
    expect(ffsubsyncCandidates(speech, base, { linear: missing, split: null })).toEqual([]);
  });
});
