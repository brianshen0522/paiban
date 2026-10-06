import { SyncCore } from '@paiban/shared';

type Cue = SyncCore.Cue;
type Segment = SyncCore.Segment;
type Speech = SyncCore.Speech;

/**
 * One line heard and recognised in the film, paired with the subtitle line that says the same
 * thing: `cue` is the index of that line in the cue list, `y` is when the speech starts.
 */
export type Pair = { cue: number; y: number };

/** How far apart (seconds) a pair may be from an alignment and still count as agreeing with it. */
export const PAIR_TOLERANCE = 0.6;
/** Fewer agreeing pairs than this and speech recognition has no say in the result. */
export const MIN_PAIRS = 4;
/** A segment needs this many pairs of its own; a lone pair that disagrees is a mismatch, not a cut. */
const MIN_RUN = 3;

function median(values: ReadonlyArray<number>): number {
  const v = values.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** The largest group of values within `2 * tol` of each other, and its median. */
function densest(values: ReadonlyArray<number>, tol: number): { center: number; count: number } {
  const v = values.slice().sort((a, b) => a - b);
  let best = { from: 0, to: 0 };
  for (let i = 0, j = 0; i < v.length; i++) {
    while (v[i] - v[j] > 2 * tol) j++;
    if (i + 1 - j > best.to - best.from) best = { from: j, to: i + 1 };
  }
  return { center: median(v.slice(best.from, best.to)), count: best.to - best.from };
}

/** Where an alignment puts the start of cue `i`. */
export function mappedStart(cues: ReadonlyArray<Cue>, segments: ReadonlyArray<Segment>, i: number): number {
  const s = segments[SyncCore.segmentIndex({ segments: segments as Segment[] }, i)];
  return cues[i].start * s.scale + s.offset;
}

/** How many pairs an alignment agrees with. */
export function pairSupport(
  cues: ReadonlyArray<Cue>,
  pairs: ReadonlyArray<Pair>,
  segments: ReadonlyArray<Segment>,
  tol = PAIR_TOLERANCE,
): number {
  let n = 0;
  for (const p of pairs) if (Math.abs(mappedStart(cues, segments, p.cue) - p.y) <= tol) n++;
  return n;
}

/**
 * Speed, offset and cuts from recognised pairs.
 *
 * 1. The speed is the known rate under which the most pairs share one offset. A wrong rate
 *    spreads the offsets out as the film goes on; mismatched pairs land anywhere and do not
 *    gather, so a handful of them cannot win.
 * 2. With that speed, pairs that share an offset form groups; a group needs MIN_RUN pairs,
 *    and pairs in no group are mismatches. Each group is one part of the film between cuts,
 *    so groups have to follow each other in the subtitle without interleaving.
 * 3. Between two parts the cut is somewhere among the cues neither pinned down: the speech
 *    detection decides where, by the same objective the other engines are scored with.
 * 4. Each segment is re-centred on the speech within half a second. Recognised word times
 *    are good to a tenth of a second or two; this only takes up the habit of subtitles to
 *    appear a little before the voice.
 *
 * Returns null when too few pairs agree on anything.
 */
export function fitPairs(
  cues: ReadonlyArray<Cue>,
  pairs: ReadonlyArray<Pair>,
  sp: Speech | null,
  allowSplit = true,
): { segments: Segment[]; support: number } | null {
  const valid = pairs.filter((p) => p.cue >= 0 && p.cue < cues.length);
  if (valid.length < MIN_PAIRS) return null;
  let best: { scale: number; count: number; center: number } | null = null;
  for (const r of SyncCore.RATES) {
    const d = densest(
      valid.map((p) => p.y - r.scale * cues[p.cue].start),
      PAIR_TOLERANCE,
    );
    if (!best || d.count > best.count) best = { scale: r.scale, ...d };
  }
  if (!best || best.count < MIN_PAIRS) return null;
  const scale = best.scale;

  // Groups of pairs that share an offset under that speed, largest first. Pairs in no group
  // of MIN_RUN are mismatches.
  type Group = { offset: number; cues: number[] };
  let rest = valid.map((p) => ({ cue: p.cue, o: p.y - scale * cues[p.cue].start }));
  const groups: Group[] = [];
  while (groups.length < (allowSplit ? 4 : 1)) {
    const d = densest(
      rest.map((r) => r.o),
      PAIR_TOLERANCE,
    );
    if (d.count < (groups.length ? MIN_RUN : MIN_PAIRS)) break;
    const lo = Math.min(...rest.map((r) => r.o).filter((o) => Math.abs(o - d.center) <= PAIR_TOLERANCE));
    const members = rest.filter((r) => r.o >= lo && r.o <= lo + 2 * PAIR_TOLERANCE);
    groups.push({ offset: median(members.map((m) => m.o)), cues: members.map((m) => m.cue).sort((x, y) => x - y) });
    rest = rest.filter((r) => !members.includes(r));
  }
  if (!groups.length) return null;
  // A cut puts every line of one part before every line of the next. Groups that interleave
  // are not parts of the film; the smaller one goes.
  let parts = groups;
  for (let changed = true; changed; ) {
    changed = false;
    parts.sort((x, y) => x.cues[0] - y.cues[0]);
    for (let k = 1; k < parts.length; k++) {
      const a = parts[k - 1];
      const b = parts[k];
      if (a.cues[a.cues.length - 1] >= b.cues[0]) {
        parts = parts.filter((g) => g !== (a.cues.length < b.cues.length ? a : b));
        changed = true;
        break;
      }
    }
  }
  let segments: Segment[] = parts.map((g, k) => ({
    from: k === 0 ? 0 : g.cues[0],
    scale,
    offset: SyncCore.round3(g.offset),
  }));
  // Between two parts the cut is somewhere among the cues neither pinned down: the speech
  // detection decides where, by the objective the other engines are scored with.
  if (sp) {
    for (let k = 1; k < segments.length; k++) {
      const prev = parts[k - 1].cues;
      const lo = prev[prev.length - 1] + 1;
      const hi = parts[k].cues[0];
      let bestFrom = hi;
      let bestJ = -Infinity;
      for (let from = lo; from <= hi; from++) {
        segments[k].from = from;
        const J = SyncCore.objective(sp, cues, segments);
        if (J > bestJ) {
          bestJ = J;
          bestFrom = from;
        }
      }
      segments[k].from = bestFrom;
    }
  }
  if (sp) segments = SyncCore.refineSegments(sp, cues, segments, 0.5);
  const support = pairSupport(cues, valid, segments);
  return support >= MIN_PAIRS ? { segments, support } : null;
}

/** Which pairs an alignment agrees with. */
function agreeing(cues: ReadonlyArray<Cue>, pairs: ReadonlyArray<Pair>, segments: ReadonlyArray<Segment>): Set<number> {
  const out = new Set<number>();
  pairs.forEach((p, k) => {
    if (Math.abs(mappedStart(cues, segments, p.cue) - p.y) <= PAIR_TOLERANCE) out.add(k);
  });
  return out;
}

/** How close (seconds) a cue's start must be to a recognised sentence's start to count as a hit. */
const HIT_TOLERANCE = 0.4;
/** Fewer recognised sentences than this, and their timing says too little to referee. */
const MIN_HEARD_FOR_TIMING = 8;

/**
 * How many recognised sentences start where the alignment starts a cue (within HIT_TOLERANCE).
 * Needs no understanding of either language: subtitle lines begin when sentences begin, and
 * recognition, unlike speech detection, is not set off by music. Each sentence counts once.
 */
export function timingHits(
  cues: ReadonlyArray<Cue>,
  segments: ReadonlyArray<Segment>,
  heardAt: ReadonlyArray<number>,
): number {
  const starts = cues.map((_, i) => mappedStart(cues, segments, i)).sort((a, b) => a - b);
  let n = 0;
  for (const t of heardAt) {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (starts[m] < t) lo = m + 1;
      else hi = m;
    }
    const near = Math.min(
      lo < starts.length ? Math.abs(starts[lo] - t) : Infinity,
      lo > 0 ? Math.abs(starts[lo - 1] - t) : Infinity,
    );
    if (near <= HIT_TOLERANCE) n++;
  }
  return n;
}

/** Recognised lines inside a segment's film time before one of them is expected to agree with it. */
const HEARD_TO_JUDGE = 2;

/**
 * Segments that recognition listened to and found nothing for: at least HEARD_TO_JUDGE recognised
 * lines start inside the stretch of film the segment puts its cues in, and not one pair agrees
 * with it. A stretch nobody listened to is not judged.
 */
export function unheardSegments(
  cues: ReadonlyArray<Cue>,
  pairs: ReadonlyArray<Pair>,
  segments: ReadonlyArray<Segment>,
  heardAt: ReadonlyArray<number>,
): number {
  let n = 0;
  segments.forEach((seg, k) => {
    const to = k + 1 < segments.length ? segments[k + 1].from : cues.length;
    if (to <= seg.from) return;
    const a = cues[seg.from].start * seg.scale + seg.offset;
    const b = cues[to - 1].start * seg.scale + seg.offset;
    const heard = heardAt.filter((t) => t >= a && t <= b).length;
    if (heard < HEARD_TO_JUDGE) return;
    const backed = pairs.some(
      (p) =>
        p.cue >= seg.from &&
        p.cue < to &&
        Math.abs(p.y - (cues[p.cue].start * seg.scale + seg.offset)) <= PAIR_TOLERANCE,
    );
    if (!backed) n++;
  });
  return n;
}

/**
 * Choose among every engine's alignment. When recognised speech gives enough pairs, it is the
 * referee: the alignment that agrees with the most pairs sets the standard, and an alignment
 * that contradicts any of the pairs it agrees with (more than one in twenty, for slips) is out.
 * Of the rest, alignments with a segment that recognition listened to and found no agreeing line
 * for (`unheardSegments`) go too, if any alignment is left without one: speech detection invents
 * cuts in loud passages, and a cut nobody heard is not believed over one the words support.
 * Without enough pairs (a subtitle in another language and no model), the times recognised
 * sentences start referee instead (`timingHits`): alignments that start clearly fewer cues where
 * sentences start than the best one go.
 * The usual scoring (docs/08-media-pipeline.md, pickAlignment) chooses among the rest. Detected
 * speech alone is easily fooled by music and effects; words that match are not. With neither
 * pairs nor recognised sentences this is pickAlignment unchanged.
 */
export function pickWithPairs(
  sp: Speech,
  cues: ReadonlyArray<Cue>,
  candidates: ReadonlyArray<SyncCore.AlignCandidate>,
  pairs: ReadonlyArray<Pair>,
  heardAt: ReadonlyArray<number> = [],
): { best: SyncCore.ScoredCandidate; agree: boolean; support: number } {
  const sets = candidates.map((c) => agreeing(cues, pairs, c.segments));
  let top = 0;
  sets.forEach((set, i) => {
    if (set.size > sets[top].size) top = i;
  });
  let eligible = candidates;
  if (sets[top] && sets[top].size >= MIN_PAIRS) {
    const slack = Math.floor(0.05 * sets[top].size);
    eligible = candidates.filter((_, i) => [...sets[top]].filter((k) => !sets[i].has(k)).length <= slack);
    const heardOut = eligible.filter((c) => unheardSegments(cues, pairs, c.segments, heardAt) === 0);
    if (heardOut.length) eligible = heardOut;
  } else if (heardAt.length >= MIN_HEARD_FOR_TIMING) {
    // No words matched (another language and no model): when sentences start still tells.
    const hits = candidates.map((c) => timingHits(cues, c.segments, heardAt));
    const best = Math.max(...hits);
    const slack = Math.max(1, Math.round(0.1 * best));
    if (best > 0) eligible = candidates.filter((_, i) => hits[i] >= best - slack);
  }
  const { best } = SyncCore.pickAlignment(sp, cues, eligible);
  const engine = (m: string) => m.split('-')[0];
  const agree = candidates.some(
    (c) =>
      engine(c.method) !== engine(best.method) && SyncCore.maxStartDifference(cues, c.segments, best.segments) <= 0.15,
  );
  return { best, agree, support: pairSupport(cues, pairs, best.segments) };
}
