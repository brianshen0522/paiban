# 15 Testing

## Three lines that must not be crossed

1. **Automated tests don't connect to the outside network.** No YTS, no subtitle source, no TMDB, no public BitTorrent network. CI must pass completely in an environment with no network.
2. **Testing and development don't use copyrighted video, and automated tests don't use subtitles downloaded from real sources either.** Only the synthetic material in `fixtures/`; when a real film is needed, use the Blender Foundation's open movies (Phase 0).
3. **Tests don't need real keys.** Code paths that need a key are tested with fake values plus recorded responses.

Checks against real sources are done **by hand** (Phases 0 and 5), and the results go into the reports. Recorded responses (JSON, HTML) become test fixtures after the key values are replaced with `PLACEHOLDER`. Subtitle archives downloaded during those checks are only used to look at the format: one or two per source, kept in `.scratch/`, deleted once looked at, never in the repo (D29).

## Layers

| Layer | Tool | What it tests | How fast |
| --- | --- | --- | --- |
| Unit | Vitest | Pure logic: the sync core, subtitle encoding and parsing, parsing each source's responses, computing reservations, validating file names and URLs, scheduling rules, permission functions | A few seconds |
| Database | Vitest + a real PostgreSQL (compose starts one for testing). PGlite can run cases that don't need concurrency, but it has only one connection, so it can't test "two connections at once" | Migrations, migrations equivalent to `db/schema.sql`, `storage_usage`, `storage_admit`, `provider_take_slot`, transactions and concurrency, cascading behavior of foreign keys | A few seconds to a dozen or so |
| Service integration | Vitest, starting the three programs in the same test with a shared temporary `/data` | The workflow from download to analysis to export; restarts; cancellation | A minute or two |
| End-to-end | Playwright, against the whole system brought up by `docker compose` | Behavior the user can see | A few minutes |

No layer should depend on details the layer below has already tested. For example, end-to-end tests don't need to re-verify every corner of Big5 decoding; that's the unit tests' job.

## Offline end-to-end flow

The whole main flow (search → download → analysis → find subtitles → sync → export → download MKV) must run to the end with no network. It needs three stand-ins, all of which appear only in the test and development compose setup:

**Fake YTS**: a very small HTTP service that serves `list_movies.json` and `movie_details.json`, with responses shaped like the real ones ([05-yts.md](05-yts.md)). The film list is the prototype's 14 old films. The three versions of one of them have info hashes that point to the three files from local seeding below.

**Local seeding**: one WebTorrent client seeds three files as three versions of the same film, with DHT, trackers and LSD turned off:

| File | Fake YTS labels it as | Purpose |
| --- | --- | --- |
| `fixtures/clip.webm` | 720p x264 8-bit | The lead in end-to-end tests: the browser really can play it (see the notes below), and it counts as "can play directly" |
| `fixtures/clip.mp4` | 1080p x264 8-bit | Service integration tests (the ones that don't go through a browser): the analysis results must equal `fixtures/data.json` exactly |
| `fixtures/clip.hevc10.mp4` | 2160p x265 10-bit | The "can't play directly" version: audio file, preview file, reservation |

The `torrent` program uses a test-only hook (environment variable `TORRENT_TEST_PEERS=seed:51801`) to call `addPeer` directly after adding the torrent. Do it the way `reference/torrent/local-swarm-test.mjs` does. A torrent's info hash depends on the file contents and the piece size, so the seeding service computes it at startup and writes it somewhere the fake YTS can read.

**Fake subtitle source**: an HTTP service that returns recorded responses and `fixtures/archive.zip` by path (`tools/fakes/src/subtitles.ts`; in development `pnpm dev` starts it too, on port 8091). Only *Inception* (`tt1375666`, TMDB `27205`) has results, matching the recorded responses; the film from local seeding (the fake YTS's *Charade*, `tt9000002`) is also answered as *Inception* (`answerAsInception`), because otherwise the full flow would find nothing at the find-subtitles step (the title and year not matching doesn't matter: sources look things up by IMDb/TMDB ID). The Assrt example is handwritten, with the title "Sample Movie" (2010). Any one source can be made to return 500, return a challenge page, not respond, or return a quota error (`30900`), and it records the time each request is received, to verify queuing and "never connected".

**How the production code is pointed at these stand-ins**: the production code only connects over `https://`, never to internal addresses, and only to hosts on the allowlist, so all the stand-ins would be blocked. So there are three environment variables just for development and testing ([02-architecture.md](02-architecture.md), [12-auth.md](12-auth.md)):

```yaml
# Only in the development and test compose file. The production compose file has none of these lines.
environment:
  NODE_ENV: test                      # or development. If it's production, refuse to start when any of the below has a value
  ALLOW_LOCAL_SOURCES: "1"            # api, media: allow http:// and internal addresses
  SOURCE_OVERRIDES: >-                # api, media: fixed source host → stand-in
    {"www.justsubtitles.com": "http://fake-sources:8090/justsubtitles",
     "search.justsubtitles.com": "http://fake-sources:8090/justsubtitles-search",
     "dl.subdl.com": "http://fake-sources:8090/subdl-dl",
     "api.subdl.com": "http://fake-sources:8090/subdl",
     "api.themoviedb.org": "http://fake-sources:8090/tmdb",
     "yts-subs.com": "http://fake-sources:8090/yify",
     "subtitles.yts-subs.com": "http://fake-sources:8090/yify-dl",
     "api.assrt.net": "http://fake-sources:8090/assrt",
     "file.assrt.net": "http://fake-sources:8090/assrt-file"}
  TORRENT_TEST_PEERS: "seed:51801"    # torrent
```

- The `SOURCE_OVERRIDES` substitution happens inside the shared outbound client, and **after** the host allowlist check: the code builds `https://www.justsubtitles.com/api/subtitles/27205?lang=EN` as usual, the allowlist checks it as usual, and only in the last step is the host part replaced with the stand-in's address. So the allowlist and each source's URL-building code are still tested.
- The YTS address is a setting to begin with; the first step of the test signs in as an administrator and sets it to `http://fake-yts:8080`; `ALLOW_LOCAL_SOURCES` lets that value pass validation.
- The values of these three variables are addresses between servers, not keys.

With these three in place, the end-to-end test script is:

1. The administrator signs in and sets the YTS address (the fake one) and the storage limit.
2. Search, go to the film page, download the version that corresponds to `clip.webm`.
3. Wait until it appears in the Library and analysis is done.
4. Go to the workspace and search for subtitles (the fake source returns a few candidates, one of which is really the Big5 version of `late.zh-TW`).
5. Rank, and add the suggested one.
6. Go to Sync, auto-align, mark all the checkpoints as correct, confirm.
7. Export, wait for it to finish, download the MKV.
8. Check the downloaded file with ffprobe: one video track, one audio track, one subtitle track; extract the subtitles and compare them with `truth.zh-TW.srt`: each line's start time is within 0.1 seconds (after subtracting the offset shared by all tracks when packing).

When this one test passes, every part connects.

## Notes on browser tests

- **Don't depend on the test Chromium being able to decode H.264.** At handover, Playwright's Chromium couldn't; on 2026-10-05 Phase 0 measured that the Chromium (153) bundled with Playwright 1.63 can (H.264 High + AAC stereo and 5.1, `moov` at the end of the file, plays and seeks), but another version might change that again. Tests that need real playback still seed `fixtures/clip.webm`. The "can it play directly" rule counts WebM (VP9 plus Opus) as playable directly precisely so that this path doesn't depend on the environment ([08-media-pipeline.md](08-media-pipeline.md)). Another option is the Chrome installed on the system (`channel: 'chrome'`), but that requires every machine that runs the tests to have Chrome installed.
- **With WebM the score may differ by 1 percentage point.** WebM's audio has been re-encoded, so speech detection differs very slightly from `clip.mp4` (28 out of 9,242 frames differ). Offset and rate aren't affected. Tests that use WebM allow plus or minus 1 percentage point when comparing scores; comparisons that must be exactly equal (analysis results against `data.json`) use `clip.mp4`, in tests that don't go through a browser.
- Videos need to autoplay: launch the browser with `--autoplay-policy=no-user-gesture-required`.
- Don't use a fixed `waitForTimeout` to wait for asynchronous results; wait for state on the screen (the score changed, the status tag changed). The prototype's `e2e.cjs` has fixed waits; that's a prototype, don't copy it.
- At the end of each test, check that the console has no errors.
- Layout check: run the main pages at both 1280 px and 400 px and confirm `document.documentElement.scrollWidth <= window.innerWidth`; take one screenshot each in light and dark.

## Tests carried over from the prototype and reference code

These already exist; move them into the project and switch them to the project's test tooling:

| Source | Contents | Where it goes |
| --- | --- | --- |
| `packages/shared/src/sync-core/core.test.ts` | Sync core, 17 tests | `packages/shared` (moved in Phase 1, switched from `node:test` to Vitest) |
| `reference/subtitles/text.test.mjs` | Encoding, language, Traditional/Simplified, ASS, 5 tests | The subtitle module in `apps/server` |
| `db/schema.test.mjs` | Usage, admission, preview plan, request queuing, constraints, 11 tests | The database tests in `apps/server`, switched to the schema produced by the Drizzle migrations |
| `reference/torrent/local-swarm-test.mjs` | WebTorrent behavior | Integration tests for `torrent` |
| `prototype/workbench/e2e.cjs` | Workbench, 40 checks | Playwright; see "Acceptance" in [09-sync-workbench.md](09-sync-workbench.md) |
| `prototype/platform/e2e.cjs` | Main flow of every page, 72 checks | Playwright; the scripts must be changed to run against the real back end |

## Tests that must exist

Every "Acceptance" and "Cases to test" in the documents must become tests. Below, the ones most easily missed and costliest to get wrong are gathered in one place.

**No automatic deletion**
- Scan the source: only the designated module calls functions that delete files under `/data`.
- Scan the source: **no deletion is decided by "time is up" or "this is old".** The deletion module's functions neither accept nor compute any "how long ago" condition; the places that call them don't compare timestamps. Loops that run on a timer are not themselves forbidden: `torrent` looks every 2 seconds for rows with `want = 'remove'`, and jobs check every 2 seconds whether they should stop; what they carry out is always a deletion or cancellation that someone has already pressed (see "Which clean-ups don't count as "automatic deletion"" in [10-storage.md](10-storage.md)).
- Lower the limit below usage: the number and size of files on disk are the same before and after.
- Restart each of the three programs once: nothing under `/data` disappears except `tmp/` and `*.part`.

**Storage**
- "Cases to test" in [10-storage.md](10-storage.md).

**Keys and outbound requests**
- A JustSubtitles response URL carrying `api_key`: after parsing there is no query string; it's not in the database; it's not in the logs.
- Run each source once with a fake key and search all log output for that string: it isn't found.
- Requests to hosts outside the allowlist and to internal addresses are blocked, including after redirects.
- Zimuku: during the whole test run, no request goes to its host.

**Permissions**
- Walk every route: not signed in is always 401 (except the few public ones); a member on admin routes is always 403; someone who isn't a holder is always 403 on any endpoint for that film, **even when the caller is an administrator**. This test is generated automatically from the route table, so nobody has to remember to add to it when a route is added.

**Testing switches never reach production**
- With `NODE_ENV=production`, setting `ALLOW_LOCAL_SOURCES`, `SOURCE_OVERRIDES` or `TORRENT_TEST_PEERS`: the program exits with an error rather than silently ignoring it.
- Without `ALLOW_LOCAL_SOURCES`: a YTS address that is `http://` or internal can't be saved, and the outbound client won't connect to it either.

**Jobs are never done twice, and never lost**
- The same row is queued twice: it's done only once.
- `media` is force-killed in the middle of transcoding and started again: that job starts over from the beginning, no `.part` is left behind, and the reservation isn't counted twice.
- `api` is restarted in the middle of a subtitle lookup: no source stays at "Searching…" forever.
- A film being transcoded is deleted: ffmpeg stops, after the deletion finishes there is nothing of that film under `/data`, and no new orphans show up.

**Only YTS hashes are accepted**
- `POST /api/torrents` with a hash that isn't in that film's version list: rejected, and nothing new is added to the database.
- A request with extra fields like `sizeBytes` or `magnet`: they are ignored or rejected, and the values actually used are the ones the server looked up.

**Sync doc**
- The function that applies the doc always gives the same output for the same input, and doesn't modify the input.
- The times the server computes when exporting and the times the browser shows come from the same function (`applyDoc`).

## Commands

Once the project is set up, write the actual commands into the "Commands" section of `AGENTS.md`. At minimum:

```
pnpm install
pnpm typecheck
pnpm lint
pnpm test              # unit + database + service integration
pnpm test:e2e          # brings compose up with the test setup first
pnpm dev               # local development: fake YTS, local seeding and fake subtitle source all start together
```

Once `pnpm dev` is up, the whole flow can be walked through without any keys or network. This is the state used most often during development.
