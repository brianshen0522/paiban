/**
 * The workbench's document operations (docs/09-sync-workbench.md, "Features"), as pure functions over
 * SyncDoc. Every function returns a new document and never mutates its input, so a snapshot kept in
 * the undo history stays as it was. The maths comes from SyncCore; the prototype's ui.js is only the
 * behavioural reference.
 */
import { type Cue, type Segment, SyncCore, type SyncDoc } from '@paiban/shared';

type Checkpoint = SyncCore.Checkpoint;
type Speech = SyncCore.Speech;

type CueEdit = SyncDoc['edits'][string];

const { round3 } = SyncCore;

export const HISTORY_LIMIT = 100;

export function cloneDoc(doc: SyncDoc): SyncDoc {
  return {
    v: 1,
    segments: doc.segments.map((s) => ({ ...s })),
    edits: Object.fromEntries(Object.entries(doc.edits).map(([k, e]) => [k, { ...e }])),
    anchors: doc.anchors.map((a) => ({ ...a })),
    checkpoints: doc.checkpoints.map((c) => ({ ...c })),
  };
}

/** Cue index range [from, to) of segment k. */
export function segRange(doc: SyncDoc, cueCount: number, k: number): [number, number] {
  const s = doc.segments[k];
  const next = doc.segments[k + 1];
  return [s ? s.from : 0, next ? next.from : cueCount];
}

export const segOf = (doc: SyncDoc, i: number): number => SyncCore.segmentIndex(doc, i);

/** Checkpoints inside [a, b) go back to "not listened": what was heard has changed. */
function resetCheckpoints(cps: Checkpoint[], a: number, b: number): Checkpoint[] {
  return cps.map((c) => (c.cue >= a && c.cue < b ? { ...c, status: 'todo' } : c));
}

function withoutSegAnchors(doc: SyncDoc, k: number): SyncDoc['anchors'] {
  return doc.anchors.filter((a) => segOf(doc, a.cue) !== k);
}

/** Set segment k's offset: clears that segment's anchors and re-opens its checkpoints. */
export function setOffset(doc: SyncDoc, cueCount: number, k: number, offset: number): SyncDoc {
  const [a, b] = segRange(doc, cueCount, k);
  return {
    ...doc,
    segments: doc.segments.map((s, j) => (j === k ? { ...s, offset: round3(offset) } : s)),
    anchors: withoutSegAnchors(doc, k),
    checkpoints: resetCheckpoints(doc.checkpoints, a, b),
  };
}

/**
 * Change the speed of segment k while the selected line stays where it is on screen (it is the
 * pivot; when it is outside the segment the segment's first line is).
 */
export function setRate(doc: SyncDoc, cues: ReadonlyArray<Cue>, k: number, sel: number, scale: number): SyncDoc {
  const [a, b] = segRange(doc, cues.length, k);
  const seg = doc.segments[k];
  if (!seg) return doc;
  const piv = sel >= a && sel < b ? sel : a;
  const base = cues[piv]?.start ?? 0;
  const keep = base * seg.scale + seg.offset;
  return {
    ...doc,
    segments: doc.segments.map((s, j) => (j === k ? { ...s, scale, offset: round3(keep - base * scale) } : s)),
    anchors: withoutSegAnchors(doc, k),
    checkpoints: resetCheckpoints(doc.checkpoints, a, b),
  };
}

/** The pivot line setRate keeps in place, for the message. */
export function ratePivot(doc: SyncDoc, cueCount: number, k: number, sel: number): number {
  const [a, b] = segRange(doc, cueCount, k);
  return sel >= a && sel < b ? sel : a;
}

/** Auto-align's answer replaces the segments, clears every anchor and re-opens every checkpoint. Line edits stay. */
export function applyAlignment(doc: SyncDoc, segments: ReadonlyArray<Segment>): SyncDoc {
  return {
    ...doc,
    segments: segments.map((s) => ({ from: s.from, scale: s.scale, offset: round3(s.offset) })),
    anchors: [],
    checkpoints: doc.checkpoints.map((c) => ({ ...c, status: 'todo' })),
  };
}

/** Snap segment k to speech within ±1.5 s at its current speed. Null when it is already within 5 ms. */
export function snap(
  doc: SyncDoc,
  cues: ReadonlyArray<Cue>,
  speech: Speech,
  k: number,
): { doc: SyncDoc; delta: number } | null {
  const seg = doc.segments[k];
  if (!seg) return null;
  const [a, b] = segRange(doc, cues.length, k);
  const idxs: number[] = [];
  for (let i = a; i < b; i++) idxs.push(i);
  if (!idxs.length) return null;
  const best = SyncCore.bestLinear(speech, cues, idxs, [seg.scale], seg.offset, 1.5, 0.01);
  const delta = best.offset - seg.offset;
  if (Math.abs(delta) < 0.005) return null;
  return { doc: setOffset(doc, cues.length, k, best.offset), delta };
}

/**
 * "This line is at t": one anchor in the segment sets the offset, two or more also the speed
 * (fitAnchors). Placing an anchor on the same line again moves it.
 */
export function placeAnchor(
  doc: SyncDoc,
  cues: ReadonlyArray<Cue>,
  i: number,
  t: number,
): { doc: SyncDoc; count: number; scale: number; offset: number } {
  const k = segOf(doc, i);
  const anchors = [...doc.anchors.filter((a) => a.cue !== i), { cue: i, t: round3(t) }];
  const mine = anchors.filter((a) => segOf(doc, a.cue) === k);
  const seg = doc.segments[k] ?? { from: 0, scale: 1, offset: 0 };
  const fit = SyncCore.fitAnchors(cues, seg, mine);
  const [a, b] = segRange(doc, cues.length, k);
  return {
    doc: {
      ...doc,
      segments: doc.segments.map((s, j) => (j === k ? { ...s, scale: fit.scale, offset: fit.offset } : s)),
      anchors,
      checkpoints: resetCheckpoints(doc.checkpoints, a, b),
    },
    count: mine.length,
    scale: fit.scale,
    offset: fit.offset,
  };
}

export type SplitResult = { ok: true; doc: SyncDoc } | { ok: false; reason: 'first' | 'already' };

/** Start a new segment at line i, inheriting the speed and offset of the one it was in. */
export function split(doc: SyncDoc, i: number): SplitResult {
  if (i <= 0) return { ok: false, reason: 'first' };
  if (doc.segments.some((s) => s.from === i)) return { ok: false, reason: 'already' };
  const k = segOf(doc, i);
  const s = doc.segments[k];
  if (!s) return { ok: false, reason: 'first' };
  const segments = doc.segments.slice();
  segments.splice(k + 1, 0, { from: i, scale: s.scale, offset: s.offset });
  return { ok: true, doc: { ...doc, segments } };
}

/** Merge segment k into the one before it, which keeps its speed and offset. Re-opens every checkpoint. */
export function merge(doc: SyncDoc, k: number): SyncDoc {
  if (k <= 0 || k >= doc.segments.length) return doc;
  const segments = doc.segments.slice();
  segments.splice(k, 1);
  return {
    ...doc,
    segments,
    checkpoints: doc.checkpoints.map((c) => ({ ...c, status: 'todo' })),
  };
}

export function markCheckpoint(doc: SyncDoc, j: number, status: Checkpoint['status']): SyncDoc {
  return { ...doc, checkpoints: doc.checkpoints.map((c, n) => (n === j ? { ...c, status } : c)) };
}

/** The next checkpoint after `from` (wrapping) that has not passed; -1 when all have. */
export function nextCheckpoint(doc: SyncDoc, from: number): number {
  const n = doc.checkpoints.length;
  for (let s = 1; s <= n; s++) {
    const j = (((from + s) % n) + n) % n;
    if (doc.checkpoints[j]?.status !== 'ok') return j;
  }
  return -1;
}

export type LineOp = 's-' | 's+' | 's=' | 'e-' | 'e+' | 'e=' | 'del';

function changeEdit(doc: SyncDoc, cues: ReadonlyArray<Cue>, i: number, fn: (e: CueEdit) => CueEdit): SyncDoc {
  const cue = cues[i];
  if (!cue) return doc;
  const key = String(cue.id);
  const next = fn({ ...(doc.edits[key] ?? {}) });
  const edits = { ...doc.edits };
  // An edit that no longer changes anything is dropped, so "unchanged" compares equal.
  if (!next.dStart && !next.dEnd && next.text == null && !next.deleted) delete edits[key];
  else {
    const clean: CueEdit = {};
    if (next.dStart) clean.dStart = round3(next.dStart);
    if (next.dEnd) clean.dEnd = round3(next.dEnd);
    if (next.text != null) clean.text = next.text;
    if (next.deleted) clean.deleted = true;
    edits[key] = clean;
  }
  return {
    ...doc,
    edits,
    checkpoints: doc.checkpoints.map((c) => (c.cue === i ? { ...c, status: 'todo' } : c)),
  };
}

/**
 * Marks the lines with these cue ids deleted, in one step: the lines an alignment to another
 * subtitle found nothing for (credits and the like), once the person says to delete them.
 */
export function deleteLines(doc: SyncDoc, cues: ReadonlyArray<Cue>, ids: ReadonlyArray<number>): SyncDoc {
  const want = new Set(ids);
  return cues.reduce((d, c, i) => (want.has(c.id) ? changeEdit(d, cues, i, (e) => ({ ...e, deleted: true })) : d), doc);
}

/** Line editing: ±50 ms, "set to now" for start and end, delete / restore. Stored as deltas. */
export function editLine(doc: SyncDoc, cues: ReadonlyArray<Cue>, i: number, op: LineOp, now: number): SyncDoc {
  const cue = cues[i];
  if (!cue) return doc;
  const seg = doc.segments[segOf(doc, i)] ?? { from: 0, scale: 1, offset: 0 };
  const s0 = cue.start * seg.scale + seg.offset;
  const e0 = cue.end * seg.scale + seg.offset;
  return changeEdit(doc, cues, i, (e) => {
    switch (op) {
      case 's-':
        return { ...e, dStart: (e.dStart ?? 0) - 0.05 };
      case 's+':
        return { ...e, dStart: (e.dStart ?? 0) + 0.05 };
      case 's=':
        return { ...e, dStart: now - s0 };
      case 'e-':
        return { ...e, dEnd: (e.dEnd ?? 0) - 0.05 };
      case 'e+':
        return { ...e, dEnd: (e.dEnd ?? 0) + 0.05 };
      case 'e=':
        return { ...e, dEnd: now - e0 };
      case 'del':
        return { ...e, deleted: !e.deleted };
    }
  });
}

/** Move one line by dt seconds relative to the deltas it had when the drag began. */
export function moveLine(
  doc: SyncDoc,
  cues: ReadonlyArray<Cue>,
  i: number,
  from: { dStart: number; dEnd: number },
  dt: number,
): SyncDoc {
  return changeEdit(doc, cues, i, (e) => ({ ...e, dStart: from.dStart + dt, dEnd: from.dEnd + dt }));
}

/** Replace a line's text; typing the original text back removes the edit. */
export function setText(doc: SyncDoc, cues: ReadonlyArray<Cue>, i: number, text: string): SyncDoc {
  const cue = cues[i];
  if (!cue) return doc;
  return changeEdit(doc, cues, i, (e) => {
    const next = { ...e };
    if (text === cue.text) delete next.text;
    else next.text = text;
    return next;
  });
}

/** Back to the downloaded subtitle with freshly picked checkpoints. */
export function resetDoc(cues: ReadonlyArray<Cue>, checkpointCount: number): SyncDoc {
  return { ...SyncCore.identityDoc(), checkpoints: SyncCore.pickCheckpoints(cues, checkpointCount) };
}

/** Whether two documents differ in timing or text (what turns a confirmed subtitle back into a draft). */
export function timingDiffers(a: SyncDoc, b: SyncDoc): boolean {
  return JSON.stringify(a.segments) !== JSON.stringify(b.segments) || stableEdits(a) !== stableEdits(b);
}

function stableEdits(d: SyncDoc): string {
  return JSON.stringify(
    Object.keys(d.edits)
      .sort()
      .map((k) => [k, d.edits[k]]),
  );
}

export const sameDoc = (a: SyncDoc, b: SyncDoc): boolean =>
  timingDiffers(a, b) === false &&
  JSON.stringify(a.anchors) === JSON.stringify(b.anchors) &&
  JSON.stringify(a.checkpoints) === JSON.stringify(b.checkpoints);

/* ---------------------------------------------------------------- undo history */

export type History = { past: SyncDoc[]; future: SyncDoc[] };

export const emptyHistory = (): History => ({ past: [], future: [] });

/** Record `before` as one undo step (capped at 100); a new step clears the redo stack. */
export function record(h: History, before: SyncDoc): History {
  const past = [...h.past, before];
  if (past.length > HISTORY_LIMIT) past.shift();
  return { past, future: [] };
}

export function undo(h: History, current: SyncDoc): { history: History; doc: SyncDoc } | null {
  const prev = h.past[h.past.length - 1];
  if (!prev) return null;
  return { history: { past: h.past.slice(0, -1), future: [...h.future, current] }, doc: prev };
}

export function redo(h: History, current: SyncDoc): { history: History; doc: SyncDoc } | null {
  const next = h.future[h.future.length - 1];
  if (!next) return null;
  return { history: { past: [...h.past, current], future: h.future.slice(0, -1) }, doc: next };
}

/* ---------------------------------------------------------------- numbers as the page writes them */

const MINUS = '−';

/** Offsets: sign always, U+2212 for minus, `digits` decimals (docs/17-ui.md, "How to write numbers"). */
export function signed(v: number, digits = 2): string {
  // A value that rounds to zero is written as +0.00, never −0.00.
  const negative = Number(v.toFixed(digits)) < 0;
  return (negative ? MINUS : '+') + Math.abs(v).toFixed(digits);
}

/** The editable field: plain ASCII number. */
export const plainOffset = (v: number): string => v.toFixed(2);

export const rateText = (scale: number): string => `×${scale.toFixed(4)}`;

export const pct = (v: number): string => `${Math.round(v * 100)}%`;

const pad = (n: number, w: number) => String(n).padStart(w, '0');

/** List times: minutes:seconds.millis (minutes keep counting past an hour), as in the prototype. */
export function shortTc(t: number): string {
  const neg = t < 0;
  const ms = Math.round(Math.abs(t) * 1000);
  return `${neg ? '-' : ''}${pad(Math.floor(ms / 60000), 2)}:${pad(Math.floor(ms / 1000) % 60, 2)}.${pad(ms % 1000, 3)}`;
}

export const timecode = (t: number): string => SyncCore.formatTimecode(t);

/** Ruler ticks: m:ss, with a tenth when the step is under a second. */
export function tick(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${pad(m, 2)}:${s < 10 ? '0' : ''}${Number.isInteger(s) ? s : s.toFixed(1)}`;
}

/** Overlap colour class for a line: 50 % and up green, 25 % and up amber, below red. */
export const overlapClass = (v: number): 'good' | 'warn' | 'bad' => (v >= 0.5 ? 'good' : v >= 0.25 ? 'warn' : 'bad');

/** Score colour: 70 % good, 55 % amber, below red (prototype). */
export const scoreClass = (v: number): 'good' | 'warn' | 'bad' => (v >= 0.7 ? 'good' : v >= 0.55 ? 'warn' : 'bad');

/** Text as shown on screen: SRT markup like <i> is kept in the file but not drawn. */
export const displayText = (s: string): string => s.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, '');
