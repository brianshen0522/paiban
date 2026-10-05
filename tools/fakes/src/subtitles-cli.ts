// Development: `pnpm --filter @paiban/fakes subtitles` serves the fake subtitle sources on
// FAKE_SOURCES_PORT (default 8091) and prints the SOURCE_OVERRIDES that point the app at it.
import { startFakeSources } from './subtitles.ts';

const port = Number(process.env.FAKE_SOURCES_PORT ?? 8091);
// Charade (tt9000002) is the film the local seeder serves; answering for it like Inception lets the
// whole flow, subtitles included, be walked through offline (docs/15-testing.md).
const fake = await startFakeSources({
  port,
  host: process.env.FAKE_SOURCES_HOST ?? '127.0.0.1',
  answerAsInception: ['tt9000002'],
});
console.log(`fake subtitle sources on ${fake.url}`);
console.log(`SOURCE_OVERRIDES=${JSON.stringify(fake.overrides)}`);
