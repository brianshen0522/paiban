/**
 * Paiban sync core: pure functions, no DOM, no Node APIs.
 *
 * The same module runs in the browser (workbench: nudge, snap, pins, score) and on the
 * server (auto-align job, applying a confirmed sync document before muxing).
 * It is a typed port of prototype/workbench/src/core.js; the numbers asserted in
 * core.test.ts were measured with that prototype code.
 *
 * Units: seconds for every time value; "frames" are speech frames (100 per second).
 * Only erasable TypeScript syntax is used, so `node --test` can run it without a build.
 */

export type Cue = { id: number; start: number; end: number; text: string };

/** One run of cues that shares a speed and an offset. `from` is a cue index, not a cue id. */
export type Segment = { from: number; scale: number; offset: number };

/** Per-line changes, stored as deltas so they keep travelling with their segment. */
export type CueEdit = { dStart?: number; dEnd?: number; text?: string; deleted?: boolean };

export type Anchor = { cue: number; t: number };
export type Checkpoint = { cue: number; status: 'todo' | 'ok' | 'bad' };

export type SyncDoc = {
  v: 1;
  segments: Segment[];
  edits: Record<string, CueEdit>;
  anchors: Anchor[];
  checkpoints: Checkpoint[];
};

/** Detected speech as half-open frame ranges [start, end) at `hz` frames per second. */
export type SpeechData = { hz: number; frames: number; segments: [number, number][] };

export type Speech = { n: number; hz: number; pre: Uint32Array; segs: [number, number][] };

export type MappedCue = {
  i: number;
  id: number;
  start: number;
  end: number;
  text: string;
  seg: number;
  deleted: boolean;
  edited: boolean;
};

/** What autoAlign returns. (The API's AlignResult in packages/shared/src/contracts/api.ts is the richer answer built from this.) */
export type AutoAlignResult = { J: number; segments: Segment[] };

export type AlignOptions = {
  /** Allow one break where the offset changes (a scene the subtitle's cut lacks). */
  allowSplit?: boolean;
  /** Search offsets within ±radius seconds. A jump larger than this cannot be found. */
  radius?: number;
  /** What one split costs, in seconds of dialogue. */
  splitPenalty?: number;
  /** Offset resolution in seconds. */
  step?: number;
};

/**
 * Subtitle-speed corrections that actually occur between releases of the same film,
 * most common first: when two fit a short clip equally well, the commoner one wins.
 */
export const RATES: ReadonlyArray<{ id: string; scale: number }> = [
  { id: 'same', scale: 1 },
  { id: '25to23', scale: 25 / 23.976 },
  { id: '23to25', scale: 23.976 / 25 },
  { id: '24to23', scale: 24 / 23.976 },
  { id: '23to24', scale: 23.976 / 24 },
  { id: '25to24', scale: 25 / 24 },
  { id: '24to25', scale: 24 / 25 },
];

/** Shortest time a cue may stay on screen after edits are applied. */
export const MIN_CUE_SECONDS = 0.2;

export function identityDoc(): SyncDoc {
  return { v: 1, segments: [{ from: 0, scale: 1, offset: 0 }], edits: {}, anchors: [], checkpoints: [] };
}

export function makeSpeech(data: SpeechData): Speech {
  const n = data.frames;
  const bits = new Uint8Array(n);
  const pre = new Uint32Array(n + 1);
  for (const [a, b] of data.segments) bits.fill(1, Math.max(0, a), Math.min(n, b));
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + bits[i];
  return { n, hz: data.hz, pre, segs: data.segments.map(([a, b]) => [a / data.hz, b / data.hz]) };
}

/** Number of speech frames inside [a, b) seconds. */
export function overlap(sp: Speech, a: number, b: number): number {
  let i = Math.round(a * sp.hz);
  let j = Math.round(b * sp.hz);
  if (i < 0) i = 0;
  if (j > sp.n) j = sp.n;
  return j > i ? sp.pre[j] - sp.pre[i] : 0;
}

/** Index of the segment that cue index `i` belongs to. */
export function segmentIndex(doc: Pick<SyncDoc, 'segments'>, i: number): number {
  let k = 0;
  for (let s = 0; s < doc.segments.length; s++) if (doc.segments[s].from <= i) k = s;
  return k;
}

/** Apply a sync document to the untouched subtitle. Never mutates its inputs. */
export function applyDoc(cues: ReadonlyArray<Cue>, doc: Pick<SyncDoc, 'segments' | 'edits'>): MappedCue[] {
  return cues.map((c, i) => {
    const k = segmentIndex(doc, i);
    const seg = doc.segments[k];
    const e = doc.edits[String(c.id)] ?? {};
    const start = c.start * seg.scale + seg.offset + (e.dStart ?? 0);
    let end = c.end * seg.scale + seg.offset + (e.dEnd ?? 0);
    if (end < start + MIN_CUE_SECONDS) end = start + MIN_CUE_SECONDS;
    return {
      i,
      id: c.id,
      start,
      end,
      text: e.text != null ? e.text : c.text,
      seg: k,
      deleted: !!e.deleted,
      edited: !!(e.dStart || e.dEnd || e.text != null),
    };
  });
}

/** Share of one cue's time that overlaps detected speech, 0 to 1. */
export function cueScore(sp: Speech, c: { start: number; end: number }): number {
  const len = Math.max(1, Math.round((c.end - c.start) * sp.hz));
  return overlap(sp, c.start, c.end) / len;
}

/** Share of all cue time that overlaps detected speech, 0 to 1. Deleted cues do not count. */
export function totalScore(
  sp: Speech,
  mapped: ReadonlyArray<{ start: number; end: number; deleted?: boolean }>,
): number {
  let ov = 0;
  let len = 0;
  for (const c of mapped) {
    if (c.deleted) continue;
    ov += overlap(sp, c.start, c.end);
    len += Math.max(1, Math.round((c.end - c.start) * sp.hz));
  }
  return len ? ov / len : 0;
}

/** A cue earns its overlap with speech and loses half of any speech in the 0.3 s just before it starts. */
function gain(sp: Speech, a: number, b: number): number {
  return overlap(sp, a, b) - 0.5 * overlap(sp, a - 0.3, a);
}

/**
 * The quantity autoAlign maximises, for an arbitrary set of segments.
 * Use it to compare alignments that came from different tools on equal terms.
 */
export function objective(sp: Speech, cues: ReadonlyArray<Cue>, segments: ReadonlyArray<Segment>): number {
  let J = 0;
  cues.forEach((c, i) => {
    const seg = segments[segmentIndex({ segments: segments as Segment[] }, i)];
    J += gain(sp, c.start * seg.scale + seg.offset, c.end * seg.scale + seg.offset);
  });
  return J;
}

/**
 * rows[k][o] = how well the first k cues of `idxs` fit at offset `lo + o * step`, for one speed.
 * With `keepRows` false only the last row is kept (enough when no split is searched).
 */
function gainTable(
  sp: Speech,
  cues: ReadonlyArray<Cue>,
  idxs: ReadonlyArray<number>,
  scale: number,
  lo: number,
  step: number,
  count: number,
  keepRows: boolean,
): Float32Array[] {
  let prev = new Float32Array(count);
  const rows: Float32Array[] = [prev];
  for (let k = 0; k < idxs.length; k++) {
    const cur = new Float32Array(count);
    const a = cues[idxs[k]].start * scale;
    const b = cues[idxs[k]].end * scale;
    for (let o = 0; o < count; o++) {
      const off = lo + o * step;
      cur[o] = prev[o] + gain(sp, a + off, b + off);
    }
    if (keepRows) rows.push(cur);
    else rows[0] = cur;
    prev = cur;
  }
  return rows;
}

/**
 * Best offset index of `top - bottom`. Ties go to the later offset: a cue that could sit
 * anywhere over a shorter utterance should start with it and linger, not start early.
 */
function argmaxRange(top: Float32Array, bottom: Float32Array | null, count: number): { J: number; o: number } {
  let best = -Infinity;
  let at = 0;
  for (let o = 0; o < count; o++) {
    const v = top[o] - (bottom ? bottom[o] : 0);
    if (v >= best - 1e-6) {
      if (v > best) best = v;
      at = o;
    }
  }
  return { J: best, o: at };
}

/** Linear fit for one run of cues, searched around a centre offset. Used by "snap to speech". */
export function bestLinear(
  sp: Speech,
  cues: ReadonlyArray<Cue>,
  idxs: ReadonlyArray<number>,
  scales: ReadonlyArray<number>,
  centre: number,
  radius: number,
  step = 0.01,
): { J: number; scale: number; offset: number } {
  const count = Math.round((2 * radius) / step) + 1;
  const lo = centre - radius;
  let best: { J: number; scale: number; offset: number } | null = null;
  for (const s of scales) {
    const rows = gainTable(sp, cues, idxs, s, lo, step, count, false);
    const m = argmaxRange(rows[rows.length - 1], null, count);
    if (!best || m.J > best.J + 1e-6) best = { J: m.J, scale: s, offset: lo + m.o * step };
  }
  if (!best) throw new Error('bestLinear needs at least one scale');
  return best;
}

/**
 * Whole-subtitle alignment: every known speed, any offset within the radius, and optionally
 * one break where the offset changes.
 *
 * Cost: rates x cues x (2 * radius / step) overlap lookups. With allowSplit every row is kept,
 * which is cues x offsets x 4 bytes per speed (about 72 MB for 1,500 cues at radius 60).
 * Run it on the server for whole films; the browser only needs bestLinear and fitAnchors.
 */
export function autoAlign(sp: Speech, cues: ReadonlyArray<Cue>, opts: AlignOptions = {}): AutoAlignResult {
  const radius = opts.radius ?? 60;
  const step = opts.step ?? 0.01;
  const count = Math.round((2 * radius) / step) + 1;
  const lo = -radius;
  const idxs = cues.map((_, i) => i);
  const n = idxs.length;
  const penalty = (opts.splitPenalty ?? 3) * sp.hz;
  const split = !!opts.allowSplit && n >= 8;
  const cands: AutoAlignResult[] = [];
  for (const r of RATES) {
    const rows = gainTable(sp, cues, idxs, r.scale, lo, step, count, split);
    const last = rows[rows.length - 1];
    const whole = argmaxRange(last, null, count);
    let cand: AutoAlignResult = { J: whole.J, segments: [{ from: 0, scale: r.scale, offset: lo + whole.o * step }] };
    if (split) {
      for (let k = 3; k <= n - 3; k++) {
        const L = argmaxRange(rows[k], null, count);
        const R = argmaxRange(rows[n], rows[k], count);
        if (L.J + R.J - penalty > cand.J && Math.abs(L.o - R.o) * step > 0.3) {
          cand = {
            J: L.J + R.J - penalty,
            segments: [
              { from: 0, scale: r.scale, offset: lo + L.o * step },
              { from: k, scale: r.scale, offset: lo + R.o * step },
            ],
          };
        }
      }
    }
    cands.push(cand);
  }
  // A speed has to beat a commoner one by a clear margin (0.3 s of dialogue) to be chosen.
  const top = Math.max(...cands.map((c) => c.J));
  const best = cands.filter((c) => c.J >= top - 0.3 * sp.hz)[0];
  for (const s of best.segments) s.offset = round3(s.offset);
  return best;
}

/** The known ratio nearest to `scale`, if it is within `tolerance`; otherwise `scale` unchanged. */
export function snapScale(scale: number, tolerance = 0.002): number {
  let near = RATES[0].scale;
  for (const r of RATES) if (Math.abs(scale - r.scale) < Math.abs(scale - near)) near = r.scale;
  return Math.abs(scale - near) < tolerance ? near : scale;
}

/** "This line belongs here": one pin sets the offset, two or more also set the speed. */
export function fitAnchors(
  cues: ReadonlyArray<Cue>,
  seg: { scale: number; offset: number },
  anchors: ReadonlyArray<Anchor>,
): { scale: number; offset: number } {
  const n = anchors.length;
  if (!n) return { scale: seg.scale, offset: seg.offset };
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const a of anchors) {
    const x = cues[a.cue].start;
    sx += x;
    sy += a.t;
    sxx += x * x;
    sxy += x * a.t;
  }
  let scale = seg.scale;
  if (n >= 2 && n * sxx - sx * sx > 1) {
    scale = snapScale((n * sxy - sx * sy) / (n * sxx - sx * sx));
    if (scale < 0.9 || scale > 1.1) scale = seg.scale;
  }
  return { scale, offset: round3((sy - scale * sx) / n) };
}

/** Lines worth checking by ear: spread over the film, each after a clear pause. */
export function pickCheckpoints(cues: ReadonlyArray<Cue>, count: number): Checkpoint[] {
  const n = cues.length;
  const out: Checkpoint[] = [];
  const used = new Set<number>();
  const want = Math.min(count, n);
  for (let c = 0; c < want; c++) {
    const target = Math.round((n - 1) * (0.04 + (0.92 * c) / Math.max(1, want - 1)));
    let bestI = -1;
    let bestV = -Infinity;
    for (let i = Math.max(0, target - 2); i <= Math.min(n - 1, target + 2); i++) {
      if (used.has(i)) continue;
      const gap = i ? cues[i].start - cues[i - 1].end : 3;
      const v = Math.min(gap, 3) + Math.min(cues[i].end - cues[i].start, 2.5) * 0.4 - Math.abs(i - target) * 0.3;
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }
    if (bestI < 0) continue;
    used.add(bestI);
    out.push({ cue: bestI, status: 'todo' });
  }
  return out.sort((a, b) => a.cue - b.cue);
}

/**
 * Least-squares line y = scale * x + offset through paired times.
 * ffsubsync logs its result to three decimals only; fitting its output cue starts (y)
 * against the input cue starts (x) recovers the exact transform.
 */
export function fitLinear(
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
): { scale: number; offset: number; maxResidual: number } {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return { scale: 1, offset: 0, maxResidual: 0 };
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) * (xs[i] - mx);
  }
  const scale = sxx > 1e-9 ? sxy / sxx : 1;
  const offset = my - scale * mx;
  let maxResidual = 0;
  for (let i = 0; i < n; i++) maxResidual = Math.max(maxResidual, Math.abs(scale * xs[i] + offset - ys[i]));
  return { scale, offset, maxResidual };
}

/**
 * A single-segment alignment from paired times: fit the line, snap its speed to a known
 * ratio when it is close to one, then take the offset that goes with the speed actually used.
 */
export function fitLinearSegment(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): Segment {
  const n = Math.min(xs.length, ys.length);
  const fit = fitLinear(xs, ys);
  let scale = snapScale(fit.scale);
  if (scale < 0.9 || scale > 1.1) scale = 1;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += ys[i] - scale * xs[i];
  return { from: 0, scale, offset: round3(n ? sum / n : 0) };
}

/**
 * Re-centre each segment's offset on the speech around it, keeping its speed. This removes the
 * systematic early bias of ffsubsync's piecewise mode (about 0.3 s when cues linger after speech).
 */
export function refineSegments(
  sp: Speech,
  cues: ReadonlyArray<Cue>,
  segments: ReadonlyArray<Segment>,
  radius = 1.5,
): Segment[] {
  return segments.map((s, k) => {
    const to = k + 1 < segments.length ? segments[k + 1].from : cues.length;
    const idxs: number[] = [];
    for (let i = s.from; i < to; i++) idxs.push(i);
    if (!idxs.length) return { ...s };
    return {
      from: s.from,
      scale: s.scale,
      offset: round3(bestLinear(sp, cues, idxs, [s.scale], s.offset, radius).offset),
    };
  });
}

function median(values: ReadonlyArray<number>): number {
  const v = values.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * Turn per-cue offsets (output start minus scaled input start) into segments: consecutive
 * cues whose offsets agree within `tolerance` share a segment. Runs shorter than `minRun`
 * cues are treated as noise and folded into a neighbour. Each segment's offset is the
 * median of its cues.
 */
export function segmentsFromOffsets(
  offsets: ReadonlyArray<number>,
  scale: number,
  tolerance = 0.05,
  minRun = 3,
): Segment[] {
  if (!offsets.length) return [{ from: 0, scale, offset: 0 }];
  let runs: { from: number; to: number }[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const last = runs[runs.length - 1];
    if (last && Math.abs(offsets[i] - median(offsets.slice(last.from, last.to))) <= tolerance) last.to = i + 1;
    else runs.push({ from: i, to: i + 1 });
  }
  // fold short runs into the run before them (or after, for the first one)
  for (let k = 0; k < runs.length && runs.length > 1; ) {
    if (runs[k].to - runs[k].from >= minRun) {
      k += 1;
      continue;
    }
    if (k > 0) {
      runs[k - 1].to = runs[k].to;
      runs.splice(k, 1);
    } else {
      runs[1].from = runs[0].from;
      runs.splice(0, 1);
    }
  }
  // neighbours that ended up with the same offset are one segment
  const offsetOf = (r: { from: number; to: number }) => median(offsets.slice(r.from, r.to));
  runs = runs.reduce<{ from: number; to: number }[]>((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && Math.abs(offsetOf(last) - offsetOf(r)) <= tolerance) last.to = r.to;
    else acc.push({ from: r.from, to: r.to });
    return acc;
  }, []);
  return runs.map((r) => ({ from: r.from, scale, offset: round3(offsetOf(r)) }));
}

/**
 * Recover speed and segments from a piecewise-shifted output (ffsubsync --split-penalty).
 * A single line through such data is meaningless, so the speed is the median slope between
 * consecutive cues, which the few cue pairs that straddle a break cannot disturb.
 */
export function fitPiecewise(
  xs: ReadonlyArray<number>,
  ys: ReadonlyArray<number>,
  tolerance = 0.05,
  minRun = 3,
): Segment[] {
  const n = Math.min(xs.length, ys.length);
  const slopes: number[] = [];
  for (let i = 1; i < n; i++) {
    const dx = xs[i] - xs[i - 1];
    if (dx >= 0.5) slopes.push((ys[i] - ys[i - 1]) / dx);
  }
  let scale = slopes.length ? snapScale(median(slopes), 0.004) : 1;
  if (scale < 0.9 || scale > 1.1) scale = 1;
  const offsets: number[] = [];
  for (let i = 0; i < n; i++) offsets.push(ys[i] - scale * xs[i]);
  return segmentsFromOffsets(offsets, scale, tolerance, minRun);
}

/** Largest difference between where two alignments put the start of any cue. */
export function maxStartDifference(
  cues: ReadonlyArray<Cue>,
  a: ReadonlyArray<Segment>,
  b: ReadonlyArray<Segment>,
): number {
  let worst = 0;
  cues.forEach((c, i) => {
    const sa = a[segmentIndex({ segments: a as Segment[] }, i)];
    const sb = b[segmentIndex({ segments: b as Segment[] }, i)];
    worst = Math.max(worst, Math.abs(c.start * sa.scale + sa.offset - (c.start * sb.scale + sb.offset)));
  });
  return worst;
}

export type AlignCandidate = { method: string; segments: Segment[] };
export type ScoredCandidate = AlignCandidate & { J: number; score: number };

/** Position of a speed in RATES (0 = unchanged, the commonest); unknown speeds rank last. */
function rateRank(scale: number): number {
  const i = RATES.findIndex((r) => Math.abs(r.scale - scale) < 1e-6);
  return i < 0 ? RATES.length : i;
}

/**
 * Choose between alignments from different engines on equal terms. Every extra segment costs
 * `splitPenalty` seconds of dialogue. Among candidates within 0.3 s of dialogue of the best,
 * the one with the fewest segments wins, then the one with the commonest speed, then the
 * earliest in the list. `agree` says whether a candidate from another engine lands every cue
 * within 0.15 s of the winner: two independent methods agreeing is the best confidence signal
 * available.
 */
export function pickAlignment(
  sp: Speech,
  cues: ReadonlyArray<Cue>,
  candidates: ReadonlyArray<AlignCandidate>,
  splitPenalty = 3,
): { best: ScoredCandidate; agree: boolean; all: ScoredCandidate[] } {
  if (!candidates.length) throw new Error('pickAlignment needs at least one candidate');
  const all: ScoredCandidate[] = candidates.map((c) => ({
    ...c,
    J: objective(sp, cues, c.segments) - splitPenalty * sp.hz * (c.segments.length - 1),
    score: totalScore(sp, applyDoc(cues, { segments: c.segments, edits: {} })),
  }));
  const top = Math.max(...all.map((c) => c.J));
  const near = all.filter((c) => c.J >= top - 0.3 * sp.hz);
  const best = near
    .map((c, order) => ({ c, order }))
    .sort(
      (a, b) =>
        a.c.segments.length - b.c.segments.length ||
        rateRank(a.c.segments[0].scale) - rateRank(b.c.segments[0].scale) ||
        a.order - b.order,
    )[0].c;
  const engine = (m: string) => m.split('-')[0];
  const agree = all.some(
    (c) => engine(c.method) !== engine(best.method) && maxStartDifference(cues, c.segments, best.segments) <= 0.15,
  );
  return { best, agree, all };
}

export function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

/** 01:02:03,456 by default; pass '.' for WebVTT. Negative times keep their sign. */
export function formatTimecode(t: number, sep = ','): string {
  const neg = t < 0;
  const ms = Math.round(Math.abs(t) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${(neg ? '-' : '') + pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${sep}${pad(ms % 1000, 3)}`;
}

/**
 * The subtitle as it will be muxed: deleted cues dropped, times clamped at zero,
 * cues in start order, numbered from 1. UTF-8 text, LF line endings.
 */
export function toSrt(mapped: ReadonlyArray<MappedCue>): string {
  const kept = mapped
    .filter((c) => !c.deleted)
    .slice()
    .sort((a, b) => a.start - b.start || a.i - b.i);
  return kept
    .map((c, n) => {
      const start = Math.max(0, c.start);
      const end = Math.max(start + MIN_CUE_SECONDS, c.end);
      return `${n + 1}\n${formatTimecode(start)} --> ${formatTimecode(end)}\n${c.text}\n`;
    })
    .join('\n');
}
