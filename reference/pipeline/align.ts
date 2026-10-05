/**
 * The auto-align job, end to end, as a runnable reference.
 *
 *   FFSUBSYNC=/opt/ffs/bin/ffsubsync node align.ts <dir with ref.npz and speech.json> <subtitle.srt> [--no-split]
 *
 * Two independent engines look at the same detected speech:
 *   1. ffsubsync, once for a single offset and once piecewise (--split-penalty);
 *   2. the sync core's own search (../sync-core/core.ts).
 * ffsubsync's results are re-centred on the speech, then all candidates are scored with the
 * same objective and the best one wins. Agreement between the engines is reported as a
 * confidence signal. Prints one JSON object on stdout.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Core from '../../packages/shared/src/sync-core/core.ts';

const [dir, subtitlePath, flag] = process.argv.slice(2);
if (!dir || !subtitlePath) {
  console.error('usage: node align.ts <dir with ref.npz and speech.json> <subtitle.srt> [--no-split]');
  process.exit(2);
}
const allowSplit = flag !== '--no-split';
const FFSUBSYNC = process.env.FFSUBSYNC || 'ffsubsync';
const MAX_OFFSET_SECONDS = 60;

/** Minimal SRT reader. The app aligns its own normalized cue list instead. */
function parseSrt(s: string): Core.Cue[] {
  const tc = (x: string) => {
    const m = x.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) throw new Error('bad timecode ' + x);
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  };
  return s.replace(/^﻿/, '').replace(/\r/g, '').trim().split(/\n\n+/).map((block, i) => {
    const lines = block.split('\n');
    const [a, b] = lines[1].split(' --> ');
    return { id: i + 1, start: tc(a), end: tc(b), text: lines.slice(2).join('\n') };
  });
}

const cues = parseSrt(fs.readFileSync(subtitlePath, 'utf8'));
const sp = Core.makeSpeech(JSON.parse(fs.readFileSync(path.join(dir, 'speech.json'), 'utf8')));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'align-'));

// ffsubsync only needs the timing. Writing the cue id as the text keeps the subtitle's words out
// of its logs and lets the output be matched back by id even if a cue were dropped or reordered.
const probe = path.join(tmp, 'in.srt');
fs.writeFileSync(probe, cues.map((c) => `${c.id}\n${Core.formatTimecode(c.start)} --> ${Core.formatTimecode(c.end)}\n#${c.id}\n`).join('\n'));

function runFfsubsync(extra: string[]): Map<number, number> | null {
  const out = path.join(tmp, `out${extra.length}.srt`);
  const r = spawnSync(FFSUBSYNC, [path.join(dir, 'ref.npz'), '-i', probe, '-o', out, '--max-offset-seconds', String(MAX_OFFSET_SECONDS), ...extra], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(out)) return null;
  const starts = new Map<number, number>();
  for (const c of parseSrt(fs.readFileSync(out, 'utf8'))) starts.set(Number(c.text.replace('#', '')), c.start);
  return starts;
}
function paired(starts: Map<number, number>): { xs: number[]; ys: number[] } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of cues) {
    const y = starts.get(c.id);
    if (y == null) return null;          // every cue must come back; otherwise do not trust the run
    xs.push(c.start);
    ys.push(y);
  }
  return { xs, ys };
}

const candidates: Core.AlignCandidate[] = [];
const started = Date.now();
const linear = runFfsubsync([]);
const linearPairs = linear && paired(linear);
if (linearPairs) candidates.push({ method: 'ffsubsync-linear', segments: Core.refineSegments(sp, cues, [Core.fitLinearSegment(linearPairs.xs, linearPairs.ys)]) });
if (allowSplit) {
  const split = runFfsubsync(['--split-penalty']);
  const splitPairs = split && paired(split);
  if (splitPairs) candidates.push({ method: 'ffsubsync-split', segments: Core.refineSegments(sp, cues, Core.fitPiecewise(splitPairs.xs, splitPairs.ys)) });
}
const ffsubsyncMs = Date.now() - started;
const coreStarted = Date.now();
candidates.push({ method: 'core', segments: Core.autoAlign(sp, cues, { allowSplit, radius: MAX_OFFSET_SECONDS }).segments });
const coreMs = Date.now() - coreStarted;
fs.rmSync(tmp, { recursive: true, force: true });

const before = Core.totalScore(sp, Core.applyDoc(cues, Core.identityDoc()));
const pick = Core.pickAlignment(sp, cues, candidates);
console.log(JSON.stringify({
  cues: cues.length,
  scoreBefore: Core.round3(before),
  score: Core.round3(pick.best.score),
  method: pick.best.method,
  agree: pick.agree,
  segments: pick.best.segments,
  candidates: pick.all.map((c) => ({ method: c.method, score: Core.round3(c.score), segments: c.segments })),
  ms: { ffsubsync: ffsubsyncMs, core: coreMs },
}, null, 1));
