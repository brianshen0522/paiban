// Waveform peaks for the timeline.
// Reads signed 16-bit little-endian mono PCM at 8 kHz on stdin and writes one (min, max) pair of
// signed bytes per window: 50 pairs per second by default, so a 2-hour film is 720 KB (310 KB gzipped).
//
//   ffmpeg -v error -i movie.mp4 -map 0:a:0 -vn -ac 1 -ar 8000 -f s16le - | node peaks.mjs 50 peaks.bin
//
// The browser reads the file as an Int8Array; pair p covers [p / 50, (p + 1) / 50) seconds.
import fs from 'node:fs';

const RATE = 8000;
const pairsPerSecond = Number(process.argv[2] || 50);
const outPath = process.argv[3];
if (!outPath || RATE % pairsPerSecond) {
  console.error('usage: node peaks.mjs <pairsPerSecond that divides 8000> <out file>   (PCM on stdin)');
  process.exit(2);
}
const window = RATE / pairsPerSecond;
const out = [];
let lo = 127, hi = -128, n = 0, carry = null, samples = 0;
for await (let chunk of process.stdin) {
  if (carry) { chunk = Buffer.concat([carry, chunk]); carry = null; }
  if (chunk.length % 2) { carry = chunk.subarray(chunk.length - 1); chunk = chunk.subarray(0, chunk.length - 1); }
  for (let i = 0; i < chunk.length; i += 2) {
    const v = chunk.readInt16LE(i) >> 8;          // keep the top 8 bits
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (++n === window) { out.push(lo, hi); lo = 127; hi = -128; n = 0; }
  }
  samples += chunk.length / 2;
}
fs.writeFileSync(outPath, Buffer.from(Int8Array.from(out).buffer));
console.error(`peaks: ${samples} samples (${(samples / RATE).toFixed(1)} s) -> ${out.length / 2} pairs, ${out.length} bytes`);
