import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computeAlignment, ffsubsyncCandidates, runFfsubsyncEngines } from '../src/subtitles/align.js';
import { normalizeCues, parseSrt } from '../src/subtitles/text.js';

/**
 * The server's automatic alignment with the real ffsubsync 0.5.1 on the fixture clip's cached
 * speech, against the last column of the table in docs/08-media-pipeline.md ("在測試素材上的結果"):
 * the same segments and speeds, offsets within 0.01 s, and both engines agreeing. Needs ffsubsync:
 * it is in the image (`pnpm test:image`); elsewhere this file is skipped, loudly.
 */
const FFSUBSYNC = spawnSync(process.env.FFSUBSYNC ?? 'ffsubsync', ['--version'], { stdio: 'ignore' }).status === 0;
if (!FFSUBSYNC) console.warn('subtitles-align.test.ts SKIPPED: ffsubsync not found here. Run `pnpm test:image`.');

const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));

const TABLE = {
  late: [{ scale: 1, offset: -2.36 }],
  rate: [{ scale: 1.04271, offset: -0.79 }],
  cut: [
    { scale: 1, offset: 1.25 },
    { scale: 1, offset: 13.24 },
  ],
} as const;

describe.skipIf(!FFSUBSYNC)('automatic alignment with ffsubsync', { timeout: 60_000 }, () => {
  it.each(['late', 'rate', 'cut'] as const)('%s matches docs/08', async (name) => {
    const data = JSON.parse(await readFile(fixture('data.json'), 'utf8'));
    const speech = { hz: 100, frames: data.speechFrames, segments: data.speech };
    const cues = normalizeCues(parseSrt(await readFile(fixture(`${name}.zh-TW.srt`), 'utf8')));
    const work = await mkdtemp(join(tmpdir(), 'paiban-align-'));
    const outputs = await runFfsubsyncEngines(fixture('clip.npz'), cues, true, work);
    expect(outputs.linear).not.toBeNull();
    expect(outputs.split).not.toBeNull();
    const extra = ffsubsyncCandidates(speech, cues, outputs);
    expect(extra.map((c) => c.method)).toEqual(['ffsubsync-linear', 'ffsubsync-split']);
    const r = computeAlignment(speech, cues, { allowSplit: true }, extra);
    expect(r.segments.length).toBe(TABLE[name].length);
    r.segments.forEach((s, i) => {
      expect(Math.abs(s.scale - TABLE[name][i].scale)).toBeLessThan(0.00001);
      expect(Math.abs(s.offset - TABLE[name][i].offset)).toBeLessThanOrEqual(0.01);
    });
    expect(r.agree).toBe(true);
  });
});
