import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AlignResult, type Cue, type SpeechData, SyncCore, type SyncDoc } from '@paiban/shared';
import type { HeardPairs } from '../asr/align.js';
import { fitPairs, pickWithPairs } from '../asr/fit.js';
import { parseSrt } from './text.js';

/**
 * Automatic alignment (docs/08-media-pipeline.md, "自動對齊"), the same computation for the
 * workbench's button (`align` tasks) and for ranking candidates. A port of
 * reference/pipeline/align.ts split in two:
 *
 *   - engines that propose segment lists (ffsubsync here; another engine, such as speech
 *     recognition, can add its own candidates later without touching the rest);
 *   - `computeAlignment`, which adds the sync core's own search and lets `pickAlignment` choose
 *     between all of them with one objective.
 */

export const MAX_OFFSET_SECONDS = 60;
const FFSUBSYNC_TIMEOUT_MS = 20_000;

type Candidate = SyncCore.AlignCandidate;

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const tidy = (segments: SyncCore.Segment[]): SyncCore.Segment[] =>
  segments.map((s) => ({ from: s.from, scale: round(s.scale, 6), offset: round(s.offset, 3) }));

/**
 * The answer for one cue list. `extra` are candidates from other engines (ffsubsync, or anything
 * added later); the core's own search is always added. `before` is the document whose score the
 * result is compared with (the identity for a candidate that was never touched). `heard` are the
 * pairs speech recognition found (docs/08, "語音辨識"): they add their own candidate and referee
 * the choice; without them this is pickAlignment over the other engines, as before.
 */
export function computeAlignment(
  speech: SpeechData,
  cues: readonly Cue[],
  opts: { allowSplit: boolean; before?: Pick<SyncDoc, 'segments' | 'edits'>; heard?: HeardPairs | null },
  extra: readonly Candidate[] = [],
): AlignResult {
  const sp = SyncCore.makeSpeech(speech);
  const core: Candidate = {
    method: 'core',
    segments: SyncCore.autoAlign(sp, cues, { allowSplit: opts.allowSplit, radius: MAX_OFFSET_SECONDS }).segments,
  };
  const candidates = [...extra, core];
  const heard = opts.heard ?? null;
  const pairs = heard?.pairs ?? [];
  const fit = pairs.length ? fitPairs(cues, pairs, sp, opts.allowSplit) : null;
  if (fit) candidates.unshift({ method: heard?.via === 'llm' ? 'asr-llm' : 'asr', segments: fit.segments });
  const pick = pickWithPairs(sp, cues, candidates, pairs);
  const before = SyncCore.totalScore(sp, SyncCore.applyDoc(cues, opts.before ?? SyncCore.identityDoc()));
  return {
    segments: tidy(pick.best.segments),
    scoreBefore: SyncCore.round3(before),
    score: SyncCore.round3(pick.best.score),
    method: pick.best.method as AlignResult['method'],
    agree: pick.agree,
    heard: heard
      ? {
          language: heard.language,
          pairs: pairs.length,
          support: pick.support,
          via: heard.via,
          llmError: heard.llmError,
        }
      : null,
  };
}

/**
 * Start times ffsubsync gave each cue, from its output. Our input carries `#<id>` as the text so
 * the output matches back by id; an output without those markers (the recorded fixtures) is
 * matched by position when the count agrees. Null when any cue is missing: do not trust the run.
 */
export function startsFromOutput(cues: readonly Cue[], output: string): number[] | null {
  const out = parseSrt(output);
  const byId = new Map<number, number>();
  for (const c of out) {
    const m = /^#(\d+)$/.exec(c.text.trim());
    if (m) byId.set(Number(m[1]), c.start);
  }
  if (byId.size === 0) return out.length === cues.length ? out.map((c) => c.start) : null;
  const ys: number[] = [];
  for (const c of cues) {
    const y = byId.get(c.id);
    if (y === undefined) return null;
    ys.push(y);
  }
  return ys;
}

/** ffsubsync's two runs (single offset, piecewise) as candidates, re-centred on the speech. */
export function ffsubsyncCandidates(
  speech: SpeechData,
  cues: readonly Cue[],
  outputs: { linear: string | null; split: string | null },
): Candidate[] {
  const sp = SyncCore.makeSpeech(speech);
  const xs = cues.map((c) => c.start);
  const out: Candidate[] = [];
  const linear = outputs.linear === null ? null : startsFromOutput(cues, outputs.linear);
  if (linear)
    out.push({
      method: 'ffsubsync-linear',
      segments: SyncCore.refineSegments(sp, cues, [SyncCore.fitLinearSegment(xs, linear)]),
    });
  const split = outputs.split === null ? null : startsFromOutput(cues, outputs.split);
  if (split)
    out.push({
      method: 'ffsubsync-split',
      segments: SyncCore.refineSegments(sp, cues, SyncCore.fitPiecewise(xs, split)),
    });
  return out;
}

/** The timing-only SRT ffsubsync reads: the text is `#<id>`, so no words reach its logs. */
export function probeSrt(cues: readonly Cue[]): string {
  return cues
    .map(
      (c) =>
        `${c.id}\n${SyncCore.formatTimecode(c.start)} --> ${SyncCore.formatTimecode(Math.max(c.end, c.start + 0.001))}\n#${c.id}\n`,
    )
    .join('\n');
}

/** Runs ffsubsync once; the output file's text, or null on any failure (exit code, timeout, no file). */
function runFfsubsync(args: string[], out: string, isCancelled: () => boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(process.env.FFSUBSYNC ?? 'ffsubsync', args, { stdio: ['ignore', 'ignore', 'ignore'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), FFSUBSYNC_TIMEOUT_MS);
    const watch = setInterval(() => {
      if (isCancelled()) child.kill('SIGKILL');
    }, 500);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      clearInterval(watch);
      if (!ok) return resolve(null);
      readFile(out, 'utf8').then(resolve, () => resolve(null));
    };
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/**
 * Both ffsubsync runs against the film's cached speech (`ref.npz`), in the job's work folder.
 * A failed run is skipped; the caller still has the core's candidate.
 */
export async function runFfsubsyncEngines(
  refNpz: string,
  cues: readonly Cue[],
  allowSplit: boolean,
  workDir: string,
  isCancelled: () => boolean = () => false,
): Promise<{ linear: string | null; split: string | null }> {
  const input = join(workDir, 'in.srt');
  await writeFile(input, probeSrt(cues));
  const base = (o: string) => [refNpz, '-i', input, '-o', o, '--max-offset-seconds', String(MAX_OFFSET_SECONDS)];
  const linearOut = join(workDir, 'linear.srt');
  const linear = await runFfsubsync(base(linearOut), linearOut, isCancelled);
  let split: string | null = null;
  if (allowSplit) {
    const splitOut = join(workDir, 'split.srt');
    split = await runFfsubsync([...base(splitOut), '--split-penalty'], splitOut, isCancelled);
  }
  return { linear, split };
}
