/**
 * Manual check: aligning a subtitle in another language than the one spoken, without a language
 * model, on Tears of Steel (Blender Foundation, CC BY). Not an automated test: it needs the film's
 * analysis and recognition from a dev run (.dev-data/media/<id>) and runs ffsubsync.
 *
 *   FFSUBSYNC=<ffsubsync> NODE_OPTIONS=--conditions=@paiban/source tsx scripts/other-language-eval.mts <lang>
 *
 * Set the media folder in D below. Prints, per distortion, what was chosen and each engine's
 * largest error against the official subtitle, with how many recognised sentence starts it hits.
 */
import fs, { mkdtempSync } from 'node:fs';
import { SyncCore } from '@paiban/shared';
import { pickWithPairs } from '../src/asr/fit.ts';
import { ffsubsyncCandidates, runFfsubsyncEngines } from '../src/subtitles/align.ts';
import { normalizeCues, parseSrt } from '../src/subtitles/text.ts';

const D = '/home/brian/projects/paiban/.dev-data/media/06387126-128e-4834-8a0f-08efedff1ef2';
const speech = JSON.parse(fs.readFileSync(`${D}/speech.json`, 'utf8'));
const asr = JSON.parse(fs.readFileSync(`${D}/asr.json`, 'utf8'));
const heardAt: number[] = asr.segments.map((s: { start: number }) => s.start);
const sp = SyncCore.makeSpeech(speech);
const truth = normalizeCues(
  parseSrt(
    fs.readFileSync(
      `/home/brian/projects/paiban/.scratch/tears-of-steel/Tears of Steel/Tears of Steel.${process.argv[2]}.srt`,
      'utf8',
    ),
  ),
);
const _mid = truth.length >> 1;
let gapAt = 1;
for (let i = 1; i < truth.length; i++)
  if (truth[i].start - truth[i - 1].end > truth[gapAt].start - truth[gapAt - 1].end) gapAt = i;
const scen: Record<string, (t: number, i: number) => number> = {
  cut: (t, i) => (i < gapAt ? t + 23.7 : t + 11.7),
  late: (t) => t + 23.7,
  lateFar: (t) => t + 47,
  rate: (t) => (t * 23.976) / 25 + 0.8,
  identity: (t) => t,
};
function hits(cues: SyncCore.Cue[], segs: SyncCore.Segment[], tol = 0.4) {
  const starts = cues
    .map((c, i) => {
      const s = segs[SyncCore.segmentIndex({ segments: segs }, i)];
      return c.start * s.scale + s.offset;
    })
    .sort((a, b) => a - b);
  let n = 0;
  for (const t of heardAt) if (starts.some((x) => Math.abs(x - t) <= tol)) n++;
  return n;
}
for (const [name, f] of Object.entries(scen).filter(([n]) => !process.env.ONLY || n === process.env.ONLY)) {
  const cues = truth.map((c, i) => ({ ...c, start: f(c.start, i), end: f(c.end, i) }));
  const work = mkdtempSync('/tmp/claude-1000/te-');
  const outs = await runFfsubsyncEngines(`${D}/ref.npz`, cues, true, work);
  const cands = [
    ...ffsubsyncCandidates(speech, cues, outs),
    { method: 'core', segments: SyncCore.autoAlign(sp, cues, { allowSplit: true, radius: 60 }).segments },
  ];
  const pick = pickWithPairs(sp, cues, cands, [], heardAt);
  const err = (segs: SyncCore.Segment[]) =>
    Math.max(
      ...cues.map((c, i) => {
        const s = segs[SyncCore.segmentIndex({ segments: segs }, i)];
        return Math.abs(c.start * s.scale + s.offset - truth[i].start);
      }),
    );
  console.log(name, 'picked', pick.best.method, 'maxErr', err(pick.best.segments).toFixed(2));
  for (const c of cands)
    console.log(
      '   ',
      c.method.padEnd(17),
      'segs',
      c.segments.length,
      'hits',
      hits(cues, c.segments),
      '/',
      heardAt.length,
      'maxErr',
      err(c.segments).toFixed(2),
    );
}
