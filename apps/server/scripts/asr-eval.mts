/**
 * Manual check of alignment by recognised speech on Tears of Steel (Blender Foundation, CC BY),
 * not part of the automated tests: it needs the film's analysis and recognition output, which
 * are made from the downloaded film and kept out of the repository (.scratch/).
 *
 *   NODE_OPTIONS=--conditions=@paiban/source tsx scripts/asr-eval.mts <lang> text|llm <asr.json>
 *
 * The film's official subtitle in <lang> is the truth. It is distorted the same ways as in
 * phase 0 (scripts/phase0/real-film-align.ts) and aligned with the sync core plus the pairs;
 * `llm` pairs through an OpenAI-compatible server at LLM_URL (default a local Ollama) with
 * LLM_MODEL. Prints one line per distortion with the pairs found and the error after alignment.
 */
import fs from 'node:fs';
import { SyncCore as Core } from '@paiban/shared';
import { fitPairs, type Pair, pairSupport, pickWithPairs } from '../src/asr/fit.ts';
import { llmPairs, openAiCompatibleMatcher } from '../src/asr/llm.ts';
import { type AsrTranscript, textPairs } from '../src/asr/text.ts';

const ROOT = '/home/brian/projects/paiban/.scratch/tears-of-steel';
const [lang = 'en', mode = 'text', asrPath] = process.argv.slice(2);
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
    .map((b) => b.split('\n'))
    .filter((l) => l.length >= 2 && l[1].includes('-->'))
    .map((l, i) => {
      const [a, b] = l[1].split(' --> ');
      return { id: i + 1, start: tc(a), end: tc(b), text: l.slice(2).join('\n') };
    });
}
const truth = parseSrt(fs.readFileSync(`${ROOT}/Tears of Steel/Tears of Steel.${lang}.srt`, 'utf8'));
const sp = Core.makeSpeech(JSON.parse(fs.readFileSync(`${ROOT}/analysis/speech.json`, 'utf8')));
const asr: AsrTranscript = JSON.parse(fs.readFileSync(asrPath, 'utf8'));
const mid = Math.floor(truth.length / 2);
const scenarios: Record<string, (t: number, i: number) => number> = {
  identity: (t) => t,
  late: (t) => t + 2.4,
  lateFar: (t) => t + 23.7,
  rate: (t) => (t * 23.976) / 25 + 0.8,
  cut: (t, i) => (i < mid ? t - 1.2 : t - 13.2),
};
const matcher =
  mode === 'llm'
    ? openAiCompatibleMatcher(
        process.env.LLM_URL ?? 'http://127.0.0.1:11434/v1',
        null,
        process.env.LLM_MODEL ?? 'qwen2.5:3b',
      )
    : null;
for (const [name, f] of Object.entries(scenarios).filter(([n]) => !process.env.ONLY || process.env.ONLY === n)) {
  const cues = truth.map((c, i) => ({ ...c, start: f(c.start, i), end: f(c.end, i) }));
  const t0 = Date.now();
  let pairs: Pair[];
  if (matcher) pairs = (await llmPairs(matcher, cues, asr, lang)).pairs;
  else pairs = textPairs(cues, asr);
  const tPairs = Date.now() - t0;
  const fit = fitPairs(cues, pairs, sp, true);
  const cands: Core.AlignCandidate[] = [
    { method: 'core', segments: Core.autoAlign(sp, cues, { allowSplit: true, radius: 60 }).segments },
  ];
  if (fit) cands.push({ method: mode === 'llm' ? 'asr-llm' : 'asr', segments: fit.segments });
  const r = pickWithPairs(
    sp,
    cues,
    cands,
    pairs,
    asr.segments.map((s) => s.start),
  );
  console.log(
    '   supports',
    cands.map((c) => `${c.method}=${pairSupport(cues, pairs, c.segments)} segs=${c.segments.length}`).join(' '),
  );
  const errs = cues
    .map((c, i) =>
      Math.abs(
        c.start * r.best.segments[Core.segmentIndex({ segments: r.best.segments }, i)].scale +
          r.best.segments[Core.segmentIndex({ segments: r.best.segments }, i)].offset -
          truth[i].start,
      ),
    )
    .sort((a, b) => a - b);
  const correctPairs = pairs.filter((p) => Math.abs(truth[p.cue].start - p.y) < 1).length;
  console.log(
    name.padEnd(9),
    `pairs ${pairs.length} (${correctPairs} right, ${tPairs} ms)`,
    `fit ${fit ? JSON.stringify(fit.segments) : 'none'}`,
    `→ ${r.best.method} support ${r.support} agree ${r.agree}`,
    `err median ${errs[errs.length >> 1].toFixed(2)} max ${errs[errs.length - 1].toFixed(2)} ≤0.5s ${((errs.filter((e) => e <= 0.5).length / errs.length) * 100).toFixed(0)}%`,
  );
}
