// Development: `pnpm --filter @paiban/fakes yts` serves the fake YTS on FAKE_YTS_PORT (default 8090).
// LOCAL_VERSIONS can point at the seeder's output so that some versions really download.
import { readFile } from 'node:fs/promises';
import type { LocalVersion } from './films.ts';
import { startFakeYts } from './yts.ts';

const port = Number(process.env.FAKE_YTS_PORT ?? 8090);
const host = process.env.FAKE_YTS_HOST ?? '127.0.0.1';
let local: LocalVersion[] = [];
if (process.env.LOCAL_VERSIONS) {
  try {
    local = JSON.parse(await readFile(process.env.LOCAL_VERSIONS, 'utf8'));
  } catch {
    console.error(`could not read ${process.env.LOCAL_VERSIONS}; serving without local versions`);
  }
}
const fake = await startFakeYts({
  port,
  host,
  local,
  ...(process.env.FAKE_YTS_PUBLIC_URL ? { publicUrl: process.env.FAKE_YTS_PUBLIC_URL } : {}),
});
console.log(`fake YTS on ${fake.url} (${local.length} local versions)`);
