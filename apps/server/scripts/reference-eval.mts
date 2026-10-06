/**
 * Manual check of aligning one subtitle to another on Tears of Steel (Blender Foundation, CC BY):
 * the official English subtitle is the aligned reference; another language's official subtitle is
 * distorted, given two credit lines at the start, and aligned to it, by timing alone or through an
 * OpenAI-compatible model at LLM_URL (LLM_MODEL).
 *
 *   NODE_OPTIONS=--conditions=@paiban/source tsx scripts/reference-eval.mts <lang> timing|llm
 */
import fs from 'node:fs';
import { SyncCore } from '@paiban/shared';
import { llmPairs, openAiCompatibleMatcher } from '../src/asr/llm.ts';
import { computeReferenceAlignment } from '../src/subtitles/align.ts';
import { referenceLines, referenceTranscript } from '../src/subtitles/reference.ts';
import { normalizeCues, parseSrt } from '../src/subtitles/text.ts';

const [lang = 'fr', mode = 'timing'] = process.argv.slice(2);
const dir = '/home/brian/projects/paiban/.scratch/tears-of-steel/Tears of Steel';
const read = (l: string) => normalizeCues(parseSrt(fs.readFileSync(`${dir}/Tears of Steel.${l}.srt`, 'utf8')));
const en = read('en');
const truth = read(lang);
const ref = { subtitleId: 'en', lines: referenceLines(en, SyncCore.identityDoc()) };
let gapAt = 1;
for (let i = 1; i < truth.length; i++)
  if ((truth[i]?.start ?? 0) - (truth[i - 1]?.end ?? 0) > (truth[gapAt]?.start ?? 0) - (truth[gapAt - 1]?.end ?? 0))
    gapAt = i;
const scen: Record<string, (t: number, i: number) => number> = {
  late: (t) => t + 2.4,
  lateFar: (t) => t + 47,
  rate: (t) => (t * 23.976) / 25 + 0.8,
  cut: (t, i) => (i < gapAt ? t + 23.7 : t + 11.7),
};
const matcher =
  mode === 'llm'
    ? openAiCompatibleMatcher(process.env.LLM_URL ?? '', null, process.env.LLM_MODEL ?? '', 300_000)
    : null;
// A messier subtitle from another source: every line's timing off by up to ±0.4 s, a third of the
// lines joined with the next, some split in two. Errors are measured on line starts that remain.
let seed = 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
function messy(cues: typeof truth, f: (t: number, i: number) => number) {
  const out: { id: number; start: number; end: number; text: string; truth: number | null }[] = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (!c) continue;
    const j = (rnd() - 0.5) * 0.8;
    const n = cues[i + 1];
    if (n && rnd() < 0.33) {
      out.push({
        id: 0,
        start: f(c.start, i) + j,
        end: f(n.end, i + 1) + j,
        text: `${c.text}\n${n.text}`,
        truth: c.start,
      });
      i++;
    } else if (rnd() < 0.15) {
      const mid = (c.start + c.end) / 2;
      out.push({
        id: 0,
        start: f(c.start, i) + j,
        end: f(mid, i) + j,
        text: c.text.slice(0, c.text.length >> 1),
        truth: c.start,
      });
      out.push({
        id: 0,
        start: f(mid, i) + j + 0.05,
        end: f(c.end, i) + j,
        text: c.text.slice(c.text.length >> 1),
        truth: null,
      });
    } else out.push({ id: 0, start: f(c.start, i) + j, end: f(c.end, i) + j, text: c.text, truth: c.start });
  }
  return out;
}
const MESSY = process.env.MESSY === '1';
for (const [name, f] of Object.entries(scen)) {
  const mess = MESSY ? messy(truth, f) : null;
  const moved = mess ?? truth.map((c, i) => ({ ...c, start: f(c.start, i), end: f(c.end, i) }));
  const target = [
    { id: 0, start: 0.5, end: 3, text: 'Sous-titres par www.example-subs.com' },
    { id: 0, start: 3.2, end: 6, text: 'Synced and corrected by somebody' },
    ...moved,
  ].map((c, i) => ({ ...c, id: i + 1 }));
  const t0 = Date.now();
  const pairs = matcher
    ? {
        language: 'en',
        via: 'llm' as const,
        llmError: null,
        pairs: (await llmPairs(matcher, target, referenceTranscript(ref.lines, 'en'), lang, undefined, 3)).pairs,
      }
    : null;
  const r = computeReferenceAlignment(ref, target, { allowSplit: true, pairs });
  const mapped = SyncCore.applyDoc(target, { segments: r.segments, edits: {} });
  const errs = (
    mess
      ? mess.flatMap((m, i) => (m.truth === null ? [] : [Math.abs((mapped[i + 2]?.start ?? 0) - m.truth)]))
      : truth.map((c, i) => Math.abs((mapped[i + 2]?.start ?? 0) - c.start))
  ).sort((a, b) => a - b);
  console.log(
    name.padEnd(8),
    r.method.padEnd(15),
    `segs ${r.segments.length}`,
    `pairs ${r.reference?.pairs} support ${r.reference?.support}`,
    `extra ${JSON.stringify(r.extraLines)}`,
    `err median ${errs[errs.length >> 1]?.toFixed(2)} max ${errs[errs.length - 1]?.toFixed(2)}`,
    `${Date.now() - t0} ms`,
  );
}
