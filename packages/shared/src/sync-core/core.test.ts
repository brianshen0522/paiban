/**
 * Run with:  pnpm --filter @paiban/shared test
 *
 * The expected numbers were measured with the prototype's core.js and with ffsubsync 0.5.1
 * on the synthetic fixtures. They are regression values for this code, not accuracy claims
 * about real films: see docs/16-risks.md.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'vitest';
import * as Core from './core.js';

const FIX = new URL('../../../../fixtures/', import.meta.url);
const read = (p: string) => fs.readFileSync(new URL(p, FIX), 'utf8');

/** Minimal SRT reader for the fixtures. The app should use a real parser. */
function parseSrt(s: string): Core.Cue[] {
  const tc = (x: string) => {
    const m = x.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) throw new Error(`bad timecode ${x}`);
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  };
  return s
    .replace(/\r/g, '')
    .trim()
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n');
      const [a, b] = lines[1].split(' --> ');
      return { id: +lines[0], start: tc(a), end: tc(b), text: lines.slice(2).join('\n') };
    });
}

const data = JSON.parse(read('data.json'));
const sp = Core.makeSpeech({ hz: data.speechHz, frames: data.speechFrames, segments: data.speech });
const truth: Core.Cue[] = data.cues.map((c: { id: number; start: number; end: number; zh: string }) => ({
  id: c.id,
  start: c.start,
  end: c.end,
  text: c.zh,
}));
const wrong = (name: string) => parseSrt(read(`${name}.zh-TW.srt`));
const ffs = (name: string) => parseSrt(read(`ffsubsync/${name}.out.srt`));
const starts = (cues: Core.Cue[]) => cues.map((c) => c.start);
const maxError = (base: Core.Cue[], segments: Core.Segment[]) =>
  Math.max(...Core.applyDoc(base, { segments, edits: {} }).map((c, i) => Math.abs(c.start - truth[i].start)));
const near = (actual: number, expected: number, tolerance: number, what: string) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what}: ${actual} is not within ${tolerance} of ${expected}`);

test('fixtures are what the tests assume', () => {
  assert.equal(truth.length, 26);
  assert.equal(sp.n, 9242);
  assert.deepEqual(
    starts(parseSrt(read('truth.zh-TW.srt'))).map((t) => Math.round(t * 1000)),
    starts(truth).map((t) => Math.round(t * 1000)),
  );
});

test('a correctly timed subtitle scores about 80%, not 100%', () => {
  // Cues start a hair early and linger after the line, so part of every cue covers silence.
  near(Core.totalScore(sp, Core.applyDoc(truth, Core.identityDoc())), 0.796, 0.01, 'score');
});

test('auto-align: whole subtitle 2.4 s late', () => {
  const base = wrong('late');
  near(Core.totalScore(sp, Core.applyDoc(base, Core.identityDoc())), 0.51, 0.02, 'score before');
  for (const allowSplit of [false, true]) {
    const r = Core.autoAlign(sp, base, { allowSplit });
    assert.equal(r.segments.length, 1);
    assert.equal(r.segments[0].scale, 1);
    near(r.segments[0].offset, -2.4, 0.06, 'offset');
    assert.ok(maxError(base, r.segments) <= 0.06);
  }
});

test('auto-align: subtitle made for a 25 fps release', () => {
  const base = wrong('rate');
  const r = Core.autoAlign(sp, base, { allowSplit: true });
  assert.equal(r.segments.length, 1);
  near(r.segments[0].scale, 25 / 23.976, 1e-9, 'scale');
  near(r.segments[0].offset, -0.8 * (25 / 23.976), 0.06, 'offset');
  assert.ok(maxError(base, r.segments) <= 0.06);
});

test('auto-align: subtitle from a different cut needs one split', () => {
  const base = wrong('cut');
  const whole = Core.autoAlign(sp, base, { allowSplit: false });
  assert.equal(whole.segments.length, 1);
  assert.ok(maxError(base, whole.segments) > 10, 'one offset cannot fit both halves');
  const split = Core.autoAlign(sp, base, { allowSplit: true });
  assert.deepEqual(
    split.segments.map((s) => s.from),
    [0, 13],
  );
  near(split.segments[0].offset, 1.2, 0.06, 'first half');
  near(split.segments[1].offset, 13.2, 0.06, 'second half');
  assert.ok(maxError(base, split.segments) <= 0.06);
  assert.ok(Core.objective(sp, base, split.segments) > Core.objective(sp, base, whole.segments));
});

test('the search radius limits how big a jump can be found', () => {
  const base = wrong('cut');
  const r = Core.autoAlign(sp, base, { allowSplit: true, radius: 5 });
  assert.ok(maxError(base, r.segments) > 1, 'a 13 s offset is outside a 5 s radius');
});

test('snap to speech moves a nearly right offset onto the speech', () => {
  const base = wrong('late');
  const b = Core.bestLinear(
    sp,
    base,
    base.map((_, i) => i),
    [1],
    -2.0,
    1.5,
  );
  near(b.offset, -2.4, 0.06, 'offset');
});

test('pins: one sets the offset, two far apart also recover the speed', () => {
  const base = wrong('rate');
  const one = Core.fitAnchors(base, { scale: 1, offset: 0 }, [{ cue: 5, t: truth[5].start }]);
  assert.equal(one.scale, 1);
  near(base[5].start + one.offset, truth[5].start, 0.001, 'pinned line');
  const two = Core.fitAnchors(base, { scale: 1, offset: 0 }, [
    { cue: 1, t: truth[1].start },
    { cue: 24, t: truth[24].start },
  ]);
  near(two.scale, 25 / 23.976, 1e-9, 'scale snaps to the known ratio');
  near(two.offset, -0.834, 0.002, 'offset');
});

test('checkpoints are spread over the film and stable', () => {
  assert.deepEqual(
    Core.pickCheckpoints(truth, 5).map((c) => c.cue),
    [0, 5, 13, 18, 24],
  );
  assert.deepEqual(
    Core.pickCheckpoints(truth, 8).map((c) => c.cue),
    [0, 5, 10, 13, 16, 18, 21, 24],
  );
  assert.equal(Core.pickCheckpoints(truth.slice(0, 3), 8).length, 3);
  assert.deepEqual(Core.pickCheckpoints([], 5), []);
});

test('applyDoc: segments, per-line deltas, text, deletion, minimum duration', () => {
  const doc: Core.SyncDoc = {
    v: 1,
    segments: [
      { from: 0, scale: 1, offset: 1 },
      { from: 2, scale: 2, offset: -1 },
    ],
    edits: { '2': { dStart: 0.5, text: 'changed' }, '3': { deleted: true }, '4': { dEnd: -100 } },
    anchors: [],
    checkpoints: [],
  };
  const cues: Core.Cue[] = [
    { id: 1, start: 10, end: 12, text: 'a' },
    { id: 2, start: 20, end: 22, text: 'b' },
    { id: 3, start: 30, end: 32, text: 'c' },
    { id: 4, start: 40, end: 42, text: 'd' },
  ];
  const m = Core.applyDoc(cues, doc);
  assert.deepEqual([m[0].start, m[0].end, m[0].seg, m[0].edited], [11, 13, 0, false]);
  assert.deepEqual([m[1].start, m[1].end, m[1].text, m[1].edited], [21.5, 23, 'changed', true]);
  assert.deepEqual([m[2].start, m[2].end, m[2].seg, m[2].deleted], [59, 63, 1, true]);
  assert.deepEqual(
    [m[3].start, Core.round3(m[3].end)],
    [79, 79.2],
    'an end before the start is pushed to the minimum duration',
  );
  assert.equal(cues[1].text, 'b', 'inputs are not mutated');
  near(
    Core.totalScore(sp, m),
    Core.totalScore(
      sp,
      m.filter((c) => !c.deleted),
    ),
    0,
    'deleted cues do not count',
  );
});

test('toSrt: numbering, order, deleted lines, negative times', () => {
  const m = Core.applyDoc(
    [
      { id: 7, start: 5, end: 6, text: 'second' },
      { id: 8, start: 1, end: 2, text: 'gone' },
      { id: 9, start: 0.5, end: 1.5, text: 'first' },
    ],
    { segments: [{ from: 0, scale: 1, offset: -1 }], edits: { '8': { deleted: true } } },
  );
  assert.equal(Core.toSrt(m), '1\n00:00:00,000 --> 00:00:00,500\nfirst\n\n2\n00:00:04,000 --> 00:00:05,000\nsecond\n');
  assert.equal(Core.formatTimecode(3723.4567), '01:02:03,457');
  assert.equal(Core.formatTimecode(-1.5, '.'), '-00:00:01.500');
});

test('ffsubsync, single offset: the exact transform is recovered from its output', () => {
  for (const name of ['late', 'rate']) {
    const base = wrong(name);
    const fit = Core.fitLinear(starts(base), starts(ffs(`${name}.linear`)));
    assert.ok(fit.maxResidual < 0.002, 'the output is a straight line through the input');
    const seg = Core.fitLinearSegment(starts(base), starts(ffs(`${name}.linear`)));
    assert.ok(maxError(base, [seg]) <= 0.06);
  }
  // On a 92 s clip two neighbouring speeds are indistinguishable; ffsubsync reports the other one here.
  assert.notEqual(Core.fitLinearSegment(starts(wrong('late')), starts(ffs('late.linear'))).scale, 1);
});

test('ffsubsync, piecewise: segments are recovered, then re-centred on the speech', () => {
  const base = wrong('cut');
  const raw = Core.fitPiecewise(starts(base), starts(ffs('cut.split')));
  assert.deepEqual(
    raw.map((s) => s.from),
    [0, 13],
  );
  const early = maxError(base, raw);
  assert.ok(early > 0.2 && early < 0.3, 'piecewise mode lands about a quarter second early on lingering cues');
  const refined = Core.refineSegments(sp, base, raw);
  assert.ok(maxError(base, refined) <= 0.06);
  // the same bias shows with one segment, and the same refinement removes it
  for (const name of ['late', 'rate']) {
    const b = wrong(name);
    const r = Core.fitPiecewise(starts(b), starts(ffs(`${name}.split`)));
    assert.equal(r.length, 1);
    assert.ok(maxError(b, r) > 0.2);
    assert.ok(maxError(b, Core.refineSegments(sp, b, r)) <= 0.06);
  }
});

test('segmentsFromOffsets ignores stray cues and merges equal neighbours', () => {
  assert.deepEqual(
    Core.segmentsFromOffsets([1, 1.01, 0.99, 1, 5, 1.02, 1, 13, 13.01, 13, 12.99, 13.02], 1).map((s) => [
      s.from,
      s.offset,
    ]),
    [
      [0, 1],
      [7, 13],
    ],
  );
  assert.deepEqual(Core.segmentsFromOffsets([], 1), [{ from: 0, scale: 1, offset: 0 }]);
  assert.deepEqual(Core.segmentsFromOffsets([2], 1), [{ from: 0, scale: 1, offset: 2 }]);
});

test('choosing between engines: the recipe in docs/08-media-pipeline.md', () => {
  for (const name of ['late', 'rate', 'cut']) {
    const base = wrong(name);
    const candidates: Core.AlignCandidate[] = [
      {
        method: 'ffsubsync-linear',
        segments: Core.refineSegments(sp, base, [Core.fitLinearSegment(starts(base), starts(ffs(`${name}.linear`)))]),
      },
      {
        method: 'ffsubsync-split',
        segments: Core.refineSegments(sp, base, Core.fitPiecewise(starts(base), starts(ffs(`${name}.split`)))),
      },
      { method: 'core', segments: Core.autoAlign(sp, base, { allowSplit: true }).segments },
    ];
    const pick = Core.pickAlignment(sp, base, candidates);
    assert.ok(maxError(base, pick.best.segments) <= 0.06, `${name}: chosen alignment is within 60 ms`);
    assert.equal(pick.agree, true, `${name}: two engines agree`);
    assert.equal(pick.best.segments.length, name === 'cut' ? 2 : 1);
    // When several candidates fit equally well (a short clip cannot tell 24 from 23.976 fps), the commonest speed wins.
    near(pick.best.segments[0].scale, name === 'rate' ? 25 / 23.976 : 1, 1e-9, `${name}: speed`);
    near(pick.best.score, 0.796, 0.01, 'score after alignment');
  }
});

test('agreement is false when the engines disagree', () => {
  const base = wrong('late');
  const pick = Core.pickAlignment(sp, base, [
    { method: 'core', segments: [{ from: 0, scale: 1, offset: -2.36 }] },
    { method: 'ffsubsync-linear', segments: [{ from: 0, scale: 1, offset: 4 }] },
  ]);
  assert.equal(pick.best.method, 'core');
  assert.equal(pick.agree, false);
});

test('film-length fixture: late, speed and cut are all recovered within 100 ms', () => {
  const film = JSON.parse(read('film/film.json'));
  const fsp = Core.makeSpeech(film.speech);
  const truthStart = new Map<number, number>(film.truth.map((c: Core.Cue) => [c.id, c.start]));
  const check = (name: string, allowSplit: boolean) => {
    const base: Core.Cue[] = film[name];
    const r = Core.autoAlign(fsp, base, { allowSplit });
    const errors = Core.applyDoc(base, { segments: r.segments, edits: {} }).map((c) =>
      Math.abs(c.start - (truthStart.get(c.id) as number)),
    );
    return { r, good: errors.filter((e) => e <= 0.1).length, n: errors.length };
  };
  const late = check('late', false);
  assert.equal(late.good, late.n);
  near(late.r.segments[0].offset, -2.37, 0.02, 'late offset');
  const pal = check('pal', false);
  assert.equal(pal.good, pal.n);
  near(pal.r.segments[0].scale, 25 / 23.976, 1e-9, 'pal scale');
  const cutWhole = check('cut', false);
  assert.ok(cutWhole.good < cutWhole.n, 'one offset leaves part of the film wrong');
  const cut = check('cut', true);
  assert.equal(cut.good, cut.n);
  assert.deepEqual(
    cut.r.segments.map((s) => s.from),
    [0, 33],
  );
  near(cut.r.segments[1].offset - cut.r.segments[0].offset, 40, 0.05, 'the missing scene is 40 s long');
});
