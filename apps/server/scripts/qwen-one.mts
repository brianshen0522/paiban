import fs from 'node:fs';
import { openAiCompatibleMatcher } from '../src/asr/llm.ts';
import { cuesBetween, sourceRange } from '../src/asr/text.ts';

const tc = (x: string) => {
  const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(x);
  if (!m) throw new Error(x);
  return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
};
const cues = fs
  .readFileSync('/home/brian/projects/paiban/.scratch/tears-of-steel/Tears of Steel/Tears of Steel.fr.srt', 'utf8')
  .replace(/\r/g, '')
  .trim()
  .split(/\n\n+/)
  .map((b) => b.split('\n'))
  .filter((l) => l[1]?.includes('-->'))
  .map((l, i) => ({ id: i, start: tc(l[1].split(' --> ')[0]), end: 0, text: l.slice(2).join(' ') }));
const asr = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const [ws, wl] = asr.windows[1];
const heard = asr.segments
  .map((s: { start: number; text: string }, id: number) => ({ id, t: s.start, text: s.text }))
  .filter((h: { t: number }) => h.t >= ws && h.t < ws + wl);
const [lo, hi] = sourceRange(ws, ws + wl);
const lines = cuesBetween(cues, lo, hi).map((i) => ({ id: i, t: cues[i].start, text: cues[i].text }));
const t0 = Date.now();
const m = await openAiCompatibleMatcher(
  'http://127.0.0.1:11434/v1',
  null,
  'qwen2.5:3b',
  3_000_000,
)({ heardLanguage: 'en', subtitleLanguage: 'fr', heard, lines });
console.log('seconds', (Date.now() - t0) / 1000, 'heard', heard.length, 'lines', lines.length);
for (const x of m) {
  const h = heard.find((y: { id: number }) => y.id === x.heard);
  const c = cues[x.line];
  console.log(Math.abs((h?.t ?? 0) - (c?.start ?? 0)) < 1.5 ? 'OK ' : 'BAD', h?.t, h?.text, '<>', c?.start, c?.text);
}
