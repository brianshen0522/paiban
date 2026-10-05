// Development: `pnpm --filter @paiban/fakes seed` seeds the three fixture clips and writes the
// versions the fake YTS should list for them (Charade, docs/15-testing.md) to LOCAL_VERSIONS.
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { LocalVersion } from './films.ts';
import { startSeeder } from './seed.ts';

const fixtures = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));
const port = Number(process.env.SEED_PORT ?? 51801);
const out = process.env.LOCAL_VERSIONS ?? fileURLToPath(new URL('../local-versions.json', import.meta.url));
// SEED_EXTRA_FILM: a longer film on this machine to try the whole flow on, listed as a 2160p
// version of the same film. Only ever a Blender Foundation open movie (AGENTS.md rule 5).
const extraFilm = process.env.SEED_EXTRA_FILM;
const s = await startSeeder(
  [fixtures('clip.webm'), fixtures('clip.mp4'), fixtures('clip.hevc10.mp4'), ...(extraFilm ? [extraFilm] : [])],
  port,
);
const [webm, mp4, hevc] = s.seeded;
if (!webm || !mp4 || !hevc) throw new Error('seeding failed');
const versions: LocalVersion[] = [
  {
    ytsId: 2,
    quality: '720p',
    type: 'bluray',
    videoCodec: 'x264',
    bitDepth: 8,
    audio: '2.0',
    hash: webm.hash,
    sizeBytes: webm.length,
  },
  {
    ytsId: 2,
    quality: '1080p',
    type: 'bluray',
    videoCodec: 'x264',
    bitDepth: 8,
    audio: '2.0',
    hash: mp4.hash,
    sizeBytes: mp4.length,
  },
  {
    ytsId: 2,
    quality: '1080p',
    type: 'bluray',
    videoCodec: 'x265',
    bitDepth: 10,
    audio: '5.1',
    hash: hevc.hash,
    sizeBytes: hevc.length,
  },
];
const extra = s.seeded[3];
if (extra)
  versions.push({
    ytsId: 2,
    quality: '2160p',
    type: 'web',
    videoCodec: 'x264',
    bitDepth: 8,
    audio: '2.0',
    hash: extra.hash,
    sizeBytes: extra.length,
  });
await writeFile(out, `${JSON.stringify(versions, null, 2)}\n`);
console.log(`seeding ${s.seeded.length} fixture clips on port ${s.port}; versions written to ${out}`);
