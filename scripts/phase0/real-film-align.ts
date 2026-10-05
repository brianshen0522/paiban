/**
 * Phase 0, item 6 (docs/14-plan.md): how well does auto-align work on a real film?
 *
 *   node scripts/phase0/real-film-align.ts <analysis dir with ref.npz + speech.json> <official.srt>
 *
 * The film's official subtitle is taken as the truth. It is distorted the same four ways the
 * fixtures are (identity, late, a different frame rate, a cut) and each version goes through
 * reference/pipeline/align.ts, the full two-engine job. For the chosen result and for every engine
 * on its own, the error is each cue's start time after alignment minus its start in the truth.
 * Prints one JSON object. Runs inside the image (ffsubsync) via scripts/phase0/real-film.sh.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Core from '../../packages/shared/src/sync-core/core.ts';

const [dir, truthPath] = process.argv.slice(2);
if (!dir || !truthPath) {
  console.error('usage: node real-film-align.ts <analysis dir> <official.srt>');
  process.exit(2);
}
const ALIGN = path.join(import.meta.dirname, '..', '..', 'reference', 'pipeline', 'align.ts');

function parseSrt(s: string): Core.Cue[] {
  const tc = (x: string) => {
    const m = x.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) throw new Error(`bad timecode ${x}`);
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
  };
  return s
    .replace(/^﻿/, '')
    .replace(/\r/g, '')
    .trim()
    .split(/\n\n+/)
    .map((block) => block.split('\n'))
    .filter((lines) => lines.length >= 2 && lines[1].includes('-->'))
    .map((lines, i) => {
      const [a, b] = lines[1].split(' --> ');
      return { id: i + 1, start: tc(a), end: tc(b), text: lines.slice(2).join('\n') };
    });
}

const truth = parseSrt(fs.readFileSync(truthPath, 'utf8'));
const sp = Core.makeSpeech(JSON.parse(fs.readFileSync(path.join(dir, 'speech.json'), 'utf8')));
const mid = Math.floor(truth.length / 2);

// Distortions as in fixtures/README.md: the subtitle is wrong by these maps, and aligning it should
// undo them.
const scenarios: Record<string, (t: number, i: number) => number> = {
  identity: (t) => t,
  late: (t) => t + 2.4,
  lateFar: (t) => t + 23.7,
  rate: (t) => (t * 23.976) / 25 + 0.8,
  cut: (t, i) => (i < mid ? t - 1.2 : t - 13.2),
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'real-align-'));
const stats = (errs: number[]) => {
  const a = errs.map(Math.abs).sort((x, y) => x - y);
  const q = (p: number) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
  const within = (s: number) => Number((a.filter((e) => e <= s).length / a.length).toFixed(3));
  return {
    median: Core.round3(q(0.5)),
    p90: Core.round3(q(0.9)),
    max: Core.round3(a[a.length - 1]),
    within100ms: within(0.1),
    within250ms: within(0.25),
    within500ms: within(0.5),
  };
};
const errorsOf = (cues: Core.Cue[], segments: Core.Segment[]) =>
  Core.applyDoc(cues, { segments, edits: {} }).map((m, i) => m.start - truth[i].start);

const out: Record<string, unknown> = {
  cues: truth.length,
  speechSegments: sp.segs.length,
  speechShare: Core.round3(sp.pre[sp.n] / sp.n),
  truthScore: Core.round3(Core.totalScore(sp, truth)),
  truthCueScores: (() => {
    const s = truth.map((c) => Core.cueScore(sp, c)).sort((a, b) => a - b);
    return {
      min: Core.round3(s[0]),
      median: Core.round3(s[Math.floor(s.length / 2)]),
      below25: s.filter((x) => x < 0.25).length,
      below50: s.filter((x) => x < 0.5).length,
    };
  })(),
  scenarios: {},
};

for (const [name, f] of Object.entries(scenarios)) {
  const cues = truth.map((c, i) => ({ ...c, start: f(c.start, i), end: f(c.end, i) }));
  const file = path.join(tmp, `${name}.srt`);
  fs.writeFileSync(file, Core.toSrt(Core.applyDoc(cues, { segments: [{ from: 0, scale: 1, offset: 0 }], edits: {} })));
  const r = spawnSync(process.execPath, [ALIGN, dir, file], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    (out.scenarios as Record<string, unknown>)[name] = { error: r.stderr.slice(0, 500) };
    continue;
  }
  const res = JSON.parse(r.stdout) as {
    score: number;
    scoreBefore: number;
    method: string;
    agree: boolean;
    segments: Core.Segment[];
    candidates: { method: string; score: number; segments: Core.Segment[] }[];
    ms: { ffsubsync: number; core: number };
  };
  (out.scenarios as Record<string, unknown>)[name] = {
    picked: res.method,
    agree: res.agree,
    scoreBefore: res.scoreBefore,
    score: res.score,
    segments: res.segments,
    error: stats(errorsOf(cues, res.segments)),
    engines: Object.fromEntries(
      res.candidates.map((c) => [
        c.method,
        { score: c.score, segments: c.segments.length, error: stats(errorsOf(cues, c.segments)) },
      ]),
    ),
    ms: res.ms,
  };
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
