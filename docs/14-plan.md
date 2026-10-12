# 14 Implementation plan

Ten phases. At the end of each phase the system runs and can be demonstrated, and each phase has clear acceptance criteria.

## Rules for every phase

**Before starting**: reread the documents listed for the phase.

**While working**:
- Commit in small steps. Every commit passes type checking, lint and tests.
- When the spec is unclear or contradicts itself, first write it in `docs/agent-notes.md`. If [00-decisions.md](00-decisions.md) lets you decide, decide and write down why; if it means changing a decision whose source is "Specified", "Decided for Brian" or "Assumption", or it affects other phases, stop and ask Brian (same rule as in `AGENTS.md`).
- Record departures from the spec in `docs/changes.md`: what changed, why, which documents it affects, and update those documents at the same time. The spec is alive, but it must not change quietly.

**When finishing**:
1. Type checking, lint and all tests pass.
2. Check the acceptance criteria one by one; write every one that can be automated as a test.
3. Write `docs/reports/phase-N.md`: what was done, the acceptance results, departures from the spec, problems found, what Brian needs to decide or provide before the next phase starts, and how to run this phase's work locally to see it.
4. **Stop and wait for Brian to confirm.** Do not go on to the next phase on your own.

**Definition of done** (per feature): fully typed; has tests; copy is in Traditional Chinese and kept in the copy files; has loading, empty and error states; works from the keyboard; does not break at 400 px wide; both light and dark work; no new security checklist item is violated ([12-auth.md](12-auth.md)).

## What Brian needs to provide

| Item | Needed in phase | Without it |
| --- | --- | --- |
| Information on the deployment machine: CPU, memory, disk size, operating system, x86-64 or ARM, Docker version | 0 | Assume x86-64 Linux for now. Native modules on ARM have not been verified |
| A YTS address that works now | 0, 2 | Develop against the fake YTS; postpone confirming the real part |
| TMDB key | 0, 5 | JustSubtitles matches by title; Assrt has no Chinese title to look up |
| API token for Assrt (Shooter) | 0, 5 | Assrt can only be developed from the docs and fake data; real behavior is confirmed later |
| SubDL key (optional) | 5 | Fallback mode can only be developed from the docs |
| Zimuku's current search address | 5 | The assisted button is not shown for now |
| Whether an incoming port can be opened on the router | 0, 3 | Downloads still work, just slower |
| What address the site uses, and how HTTPS is handled | 9 | Use `http://localhost:8080` for now |

Brian enters keys himself on the admin pages or writes them into his local `.env`. **Do not ask him to paste keys into the conversation, and do not write any key into the repo.**

---

## Phase 0: check the assumptions

**Goal**: before writing any feature, check the external facts this spec depends on. This handover pack contains things that could not be verified in the environment where it was prepared ([16-risks.md](16-risks.md)); fill those in now.

**Read**: README, AGENTS, 00, 02, 16; 05, 07, 08 (items 2 and 4 compare actual results against them); and every folder in `reference/`.

**Environment this phase needs**:

| Need | Items | Without it |
| --- | --- | --- |
| A working Docker (daemon running) | 1, 2, 3 | Run item 2 on the host instead, and state the host's Node, ffmpeg, Python and ffsubsync versions in the report; list items 1 and 3 as "Could not confirm". Brian decides whether to move on to Phase 1 first; redo them the first time Docker is available |
| Outbound network | 4, 5, 6 | List as "Could not confirm"; do the rest as normal |
| Desktop browsers (Chrome, Firefox, Safari) | 7 | Prepare the test page and files, write clear steps, ask Brian to open it once himself and tell you the results |
| The machine used for deployment | Conclusions of 5, 6 | Do it on the development machine and note in the report "these are development machine results"; measure the network and performance conclusions again on the deployment machine in Phase 9 |

Do not pretend to have done what you couldn't do, and don't substitute another approach to fill the gap: write it in the report.

**Do**:

1. **Skeleton**: following [02-architecture.md](02-architecture.md), set up the monorepo (`apps/web`, `apps/server`, `packages/shared`), TypeScript, lint, formatting, and test tooling.
   - Rename the three example files in `deploy/` to their real names (`docker-compose.yml`, `Dockerfile`, `Caddyfile`) and fix them to match reality; keep `.env.example`. Update every place in the docs that mentions a `*.example` file name.
   - `deploy/.env` (compose reads the one that sits next to it): if it doesn't exist, copy it from `.env.example`; if it already exists (Brian may have created it and filled in keys), keep its values. Generate random values for `POSTGRES_PASSWORD`, `SECRET_KEY` and `BOOTSTRAP_ADMIN_PASSWORD` if they are still empty and write them in; if `BOOTSTRAP_ADMIN_USERNAME` is empty, fill in `admin` (both must have values together, see [12-auth.md](12-auth.md)). Don't commit it, and don't print it in the conversation or logs. Tell Brian where the file is and which two variables hold the administrator's username and password, and ask him to open it himself.
   - `docker compose up --build` comes up with all five containers: `GET /api/health` returns `{ok: true}`, and opening the browser shows a page with the site name. `torrent` and `media` have no features yet, but they must be programs that keep running (if they exit right away the container keeps restarting): writing a line to the log every so often is enough; the heartbeat written to the database waits until Phase 1 has the tables. The image must be complete (ffmpeg, ffsubsync, extraction tools).
   - Record the actual versions of ffmpeg, Python and ffsubsync in the image. The numbers in this spec were measured on ffmpeg 6.1.1; the base image used by the example Dockerfile very likely ships a newer version.
2. **Run the reference tests in the built image**:
   - `reference/sync-core`: `node --test core.test.ts` (17 tests)
   - `reference/subtitles`: `npm ci && npm test` (5 tests)
   - `db`: `npm ci && npm test` (11 tests)
   - `reference/torrent`: `npm ci && npm test` (two local clients transfer to each other; prints PASS on success)
   - `reference/pipeline/analyze.sh` on `fixtures/clip.mp4`: the `speech.json` and `peaks.bin` it produces must match those in `fixtures/data.json`
   - `reference/pipeline/align.ts` on the three wrong subtitles: the results must match the table in [08-media-pipeline.md](08-media-pipeline.md)
   - Run `reference/pipeline/preview.sh` and `mux.sh` once each

   The handover material (`reference/`, `fixtures/`, `db/`) is not in the image (`.dockerignore` excludes it), so mount the repo into the container to run them. Roughly like this; this command **has never actually been run** (the environment that prepared the handover pack had no Docker), so adjust it as needed:

   ```bash
   docker compose -f deploy/docker-compose.yml run --rm --no-deps \
     -v "$PWD":/work -w /work -e HOME=/tmp media \
     node --test reference/sync-core/core.test.ts
   ```

   The point is "run on the image's Node, ffmpeg and ffsubsync", not on the development machine. Write these commands as a script and keep it in the repo.

   What counts as passing:

   | Item | Standard |
   | --- | --- |
   | The four test suites | All pass, with matching counts |
   | `analyze.sh` | The regions in `speech.json` equal `speech` in `fixtures/data.json`; `peaks.bin` equals `peaks` in `data.json` (base64-decoded) |
   | `align.ts` | For each of the three subtitles, the number of segments and the rate equal the last column of the table in [08-media-pipeline.md](08-media-pipeline.md), the offset is within 0.01 seconds, and `agree` is true |
   | `preview.sh` (on `fixtures/clip.hevc10.mp4`) | Produces `audio.m4a` and `proxy.mp4`; `proxy.mp4` is H.264 with stereo AAC, and every frame's timestamp equals the source's |
   | `mux.sh` (on `fixtures/clip.mp4` plus two `truth` subtitles) | One video track, one audio track, two subtitle tracks; language tags and default track correct; video and audio packets identical to the source |

   When the ffmpeg version in the image differs from 6.1.1, the `analyze.sh` results may be off by a few frames (the details of audio resampling differ). That is not a failure: write in the report how large the difference is, change the comparison to allow a tolerance (speech frames differing by under 1%, alignment results still matching the table above), and update the explanation in `fixtures/README.md`. Only a large difference is a problem.
3. **Archives**: confirm the tools in the image can extract zip, 7z and rar. You need to prepare the rar and 7z test files yourself (put the subtitle files from `fixtures/` in them; the environment that prepared the handover pack had no tools to create them). If rar can't be extracted, propose an alternative.
4. **Real external sources** (needs network; run by hand, not part of the automated tests): for each source, look up one fixed film (IMDb `tt1375666`) and compare item by item against [05-yts.md](05-yts.md) and [07-subtitle-providers.md](07-subtitle-providers.md). Skip sources you have no key for and list them in the report. Keep requests to a minimum: a few per source is enough.
   - **Response shapes** (JSON, HTML) are kept as test fixtures: first replace the values of all keys, tokens and signed query strings with `PLACEHOLDER` (keep the parameters themselves: the tests have to prove that parsing drops them), then put them in `reference/providers/` in place of the handwritten examples.
   - **Subtitle archives** are used only to confirm the format (is it a zip, what's inside, which encoding): download one per source, at most two, put them in `.scratch/` (already in `.gitignore`), and delete them once you've looked. They are not committed and not used as test fixtures (D29); archive test fixtures are home-made ones like `fixtures/archive.zip`.
5. **Real BitTorrent download**: use a torrent that may be freely and legally distributed (one of the example torrents listed in WebTorrent's official docs, e.g. the Blender Foundation's *Sintel*; take the info hash from the official docs, don't write it from memory). Confirm how DHT, trackers and the incoming port actually behave in the target environment, as well as downloading, pausing, and resuming after a forced kill and restart.
   - Do this item with **a small standalone script** (e.g. `scripts/phase0/real-swarm.mjs`, using WebTorrent directly, written the way `reference/torrent/local-swarm-test.mjs` is), not through the product's code. The product itself will never have an entry point for "download an arbitrary torrent" (D26), and don't add one for this check. Keep the script in the repo as a record; it does not go into the image.
6. **Syncing on a real film**: use *Sintel* or *Tears of Steel* (Blender Foundation open movies, with dialogue, music and sound effects, and official subtitles). Run the analysis; take the official English subtitles and separately delay them as a whole, change their rate, and cut out a piece in the middle, then run auto-align and measure the error. This is the biggest unknown in the whole spec, and the results decide whether Phase 6 needs to change its approach.
7. **Browser playback**: use ffmpeg to make a file from the open movie above that resembles the YTS format (H.264 High, AAC, another with 5.1 channels, `moov` at the end of the file), and through a minimal endpoint that supports Range, confirm it plays and can be seeked in Chrome, Firefox and Safari.

**Acceptance**:
- `docker compose up --build` succeeds on the first try, and the health check passes.
- Every test in item 2 passes in the image, with numbers matching the docs.
- `docs/reports/phase-0.md` has a clear conclusion for each of items 3 to 7: confirmed, does not match (with the actual situation and a proposed spec change), or could not confirm (with the reason and what is needed).
- Any finding that shakes the architecture (e.g. WebTorrent won't load on the target machine, or syncing is unusable on real films) goes at the very top of the report.

---

## Phase 1: accounts and shell

**Read**: 01, 02 (Code layout, Configuration, Startup and shutdown, Logging), 03, 04 (Common rules, Sign-in and accounts, users under Admin, invites, Activity log, Live updates), 11 (Shell, Sign in, Register, Reset, Profile, Users & invites, Activity log), 12, 13 (Personal preferences), 17.

**Do**:
- **Shared code first**: **move** `contracts/api.ts` and `reference/sync-core/` (`core.ts`, `core.test.ts`) into `packages/shared`, and write zod schemas from the contract. Move (`git mv`), don't copy: afterwards only the copy in `packages/shared` exists, and the original `contracts/` and `reference/sync-core/` are gone. While moving, change:
  - The import on the contract's first line (it originally points to `../reference/sync-core/core.ts`)
  - The relative paths in `core.test.ts` that read `fixtures/`; switch the tests from `node:test` to Vitest (a mechanical rewrite; cases and expected values stay the same)
  - The import in `reference/pipeline/align.ts`, and the Phase 0 script that runs the reference tests
  - Every place in the repo that mentions `contracts/api.ts` and `reference/sync-core/`: `AGENTS.md` (Order of authority, How to use the reference code, Commands), `README.md`, `docs/`, the READMEs of each subfolder, the comments in `db/schema.sql`. Search the full text and change them all at once, and record one entry in `docs/changes.md`
- **Keep `db/schema.sql`, but migrations become the source of truth.** In Phase 1, define the schema with Drizzle and generate migration files; from then on the database follows the migrations. `db/schema.sql` remains the readable version of "what this database should look like": when a table changes later, the migration and it change together. Add a test that confirms the two are equivalent (build `db/schema.sql` in one empty database, run the migrations in another, and compare the tables, columns, types, constraints and indexes on both sides). Rewrite the 11 cases in `db/schema.test.mjs` as server database tests that run against the migrated schema; once rewritten, the original test in `db/` can be deleted.
- Database migrations (all tables created at once), access to settings and keys, the first administrator (for all the cases see [12-auth.md](12-auth.md)). Heartbeats for the three services (`service_heartbeats`, once every 10 seconds, see [02-architecture.md](02-architecture.md)): `torrent` and `media` still have no features at this point, but they write heartbeats from this phase on; the System status page that shows them comes in Phase 4.
- Sign-in, sign-out, sessions, invites, registration, password reset, Profile (name, preferences, change password, devices).
- The shell (top bar, side menu, routing, permission guards, page not found, no permission, returning after sign-in to the page you were headed for), design tokens and basic components (buttons, fields, status tags, confirmation dialogs, toast messages, tables), the SSE pipe (heartbeat only for now), writing to `audit_log`, the copy files.
- The admin pages "Users & invites" and "Activity log" are done in this phase, because without them there's no way to invite a second person.

**Acceptance**:
- After starting on an empty database, you can sign in as the administrator from the environment variables.
- An administrator creates an invite → a second browser registers with the link → signs in as a member. A used, expired or nonexistent invite each shows the matching message.
- A member opening any `/admin` page sees "Only administrators can see this page."; calling `/api/admin/…` directly returns 403.
- After an account is disabled, the next request from a browser where it is already signed in signs it out.
- A password reset link works once, and stops working after 30 minutes or after it's used.
- Every item in the [12-auth.md](12-auth.md) checklist that relates to this phase has a test.
- The shell matches the prototype at 400 px, in light and in dark. The top bar's usage indicator only gets a limit in Phase 2 and usage in Phase 3, and notifications come in Phase 8: in this phase build their position and look (usage shows "—", notifications are empty) and don't leave them out, so the layout doesn't need rearranging later. Submitting the search box goes to the Search page; the Search page itself only gets content in Phase 2, so in this phase it is an empty state.
- In `packages/shared`: the 17 sync core tests pass, and the contract passes type checking. In the server database tests: the 11 cases from the original `db/schema.test.mjs` pass against the migrated schema; the "migrations are equivalent to `db/schema.sql`" test passes.

---

## Phase 2: search and film page

**Read**: 05, 04 (Search, Storage, settings and tests under Admin), 10 (How usage is counted, Admission and refusal, Preview reservation, How it appears in the interface), 11 (Search, Film page, Sources), 12 (Outbound requests), 13 (the YTS parts, Test connection), 15 (fake YTS).

**Do**: the **shared outbound HTTP client** (host allowlist, blocking internal addresses, redirects, timeouts, size limits, stripping the query string from logs, plus `ALLOW_LOCAL_SOURCES` / `SOURCE_OVERRIDES` for development and testing; Phase 5's subtitle sources reuse it directly), the YTS client (configurable address, caching, shape validation, not following cross-host redirects), the fake YTS (for development and testing), the Search page (filters, pagination, every state), the film page (the versions table; in this phase the "Download" button does nothing yet, but whether it can play directly, the preview reservation and whether it fits must be computed and shown), the poster proxy, and the YTS card and test connection on the Sources page. "Whether it fits" needs usage and the limit: in this phase, write the initial storage limit into settings (`STORAGE_LIMIT_GB`, written once only), build the `Usage` query (usage is 0 at this point), and hook up the top bar's usage indicator.

**Acceptance**:
- Against the fake YTS: search, filter, sort, pagination, no results, unreachable, and a response that isn't YTS-shaped each have a test.
- When no address is set, the Search page leads the administrator to set it.
- The browser's network panel shows no request to YTS or any other external domain.
- When the address is set to one that redirects to another host, test connection reports the redirect rather than success.
- Outbound client: hosts outside the allowlist, internal addresses and `http://` are all blocked, including after redirects; with `NODE_ENV=production`, if a testing variable is set the program refuses to start.
- (When there is a real YTS address) confirm by hand that real searches and the film page work.

---

## Phase 3: downloads and the storage limit

**Read**: 06, 10, 02 (How the services talk to each other, Startup and shutdown), 03 (Downloads, Holders, Transaction boundaries, What happens when a download is deleted), 04 (Downloads, Library, Storage, Live updates, storage under Admin), 05 (versions, Magnet links), 11 (Film page, Downloads, Library, the workspace header, Storage, Storage management, Download settings), 12 (Who can do what), 13 (Download settings), 15 (local seeding).

**Do**: admission (transaction and lock), the `torrent` program (main loop, scheduling, pause, resume, retry, stalls, cleanup after failure, completion, removal, resuming after restart, seeding), "Download", "Add to my library" and "Retry" on the film page starting to work, the Downloads page (live progress), the Library page (in this phase, only the "Video downloaded" step on the card is real), the workspace shell (`GET /api/library/:torrentId`, header, three tabs; tab contents are empty states for now, later phases fill them in), holders (adding, removing, deletion by the last one), the Storage page, the Storage management page (limit, all items, force deleting films, reserved and leftovers), the Download settings page, the usage indicator, `usage` and `torrent` events, notifications for downloads finishing and failing (written to the table for now; the bell interface comes in Phase 8), the single deletion module.

**There is no `media` program yet in this phase.** So:

- Don't hook up the call that automatically asks for analysis when the workspace opens (`POST /api/media/:id/analyze`) yet: in this phase every film's analysis state is `none`, and hooking it up would leave them stuck at "Analyzing" forever. The endpoint and this call are done together in Phase 4.
- When a download finishes, `analysis_state` is always written as `none`, and the status goes straight to "Done" (see [06-torrent-worker.md](06-torrent-worker.md)). Preview assets are written as "Waiting" as planned, and the reservation is counted as usual; nobody does the work yet, and Phase 4 takes over.
- "Recount usage", deleting preview files and orphan folders wait until Phase 4; anything related to export waits until Phase 7.

**Acceptance**:
- The Phase 3 group in [10-storage.md](10-storage.md) "Cases to test" is all automated tests.
- All the integration tests in [06-torrent-worker.md](06-torrent-worker.md) "Tests" pass, using local seeding, without connecting outside.
- Force-kill the `torrent` container during a download and start it again: the download resumes, and finished parts aren't fetched again (on a normal shutdown) or are re-verified and then resumed (on a forced kill).
- Restart the `api` container during a download: the download is unaffected, and progress is correct once the page reconnects.
- Two browsers submit a download for the last bit of space at the same time: one succeeds, the other sees an explanation that there isn't enough space.
- Source scanning test: only the designated module deletes anything under `/data`; no deletion is decided by time or age (defined in [15-testing.md](15-testing.md) under "No automatic deletion").

---

## Phase 4: video analysis and preview

**Read**: 08 (After a film finishes downloading, analysis, preview assets, Common rules for jobs, Reconciliation, Manual retry), 02 (Queues, Startup and shutdown), 03 (Videos and derived files, What happens when a download is deleted), 04 (Videos, Admin), 09 (Loading, Which file to play), 10 (Preview reservation, Recounting usage, Confirmation wording), 11 (Downloads, Storage management, System status), 13 (settings for after a download finishes).

**Do**: the `media` program and the job queue, reconciliation, `tasks`, analysis (probe, waveform, speech), deciding and fixing whether a file can play directly, preview assets (audio file, preview video, progress, stopping when deleted), requesting the preview file later, `POST /api/media/:id/analyze` and the automatic call when a workspace opens (the one Phase 3 left unhooked), the video streaming endpoint (Range), the waveform and speech endpoints, the System status page (including manual retry), "Analyzing" and preview file progress on the Downloads page, recounting usage and what it finds, force deleting preview files and orphan folders. Change Phase 3's hard-coded `analysis_state = 'none'` to follow the settings.

**Acceptance**:
- `fixtures/clip.mp4` is analyzed automatically once downloaded; what the `peaks` and `speech` endpoints return matches `fixtures/data.json`.
- With automatic analysis turned off (`media.analyzeAuto`): no analysis after a download finishes; it starts automatically the first time that film's workspace is opened.
- With `fixtures/clip.hevc10.mp4` (HEVC 10-bit, 5.1 channels): the audio file and preview file are produced automatically; every frame's timestamp in the preview file equals the source's; usage is the reserved amount at first and becomes the actual amount when done.
- Delete the film halfway through converting the preview file: ffmpeg is terminated, and no files are left behind.
- The streaming endpoint supports Range (verify 206 and the right bytes with `curl -r`); someone not signed in or not a holder can't get it.
- The `media` container is restarted in the middle of a job: the job is queued again, and no `.part` is left behind.
- The same job is queued twice (simulating reconciliation and a notification triggering at the same time): it is done only once.
- The fake YTS labels an HEVC file as x264 (predicted to play directly, actually can't): after probing, a preview plan is added; when there isn't enough space, `PREVIEW_NO_SPACE` is recorded instead of failing.
- A file with no audio track: analysis is marked as failed (`NO_AUDIO`), the preview video is still made, and `GET /api/library/:torrentId` responds as usual (the film can enter the workspace).
- The Phase 4 group in [10-storage.md](10-storage.md) "Cases to test".

---

## Phase 5: subtitle sources (all at once)

**Read**: 07 (all of it), 02 (Queues), 03 (Subtitles, What happens when a download is deleted), 04 (Subtitles), 08 (Auto-align, Common rules for jobs, Reconciliation), 09 (the shape of the sync doc; it is created at "add" time), 10 (Small files), 11 (Workspace: Subtitles), 12 (Outbound requests, Uploads and archives), 13 (sources, Keys, Test connection), 15 (fake subtitle source).

**Do**: reuse the outbound HTTP client from Phase 2, adding each source's host list and request queuing (`provider_take_slot`); the source interface; `subtitle.search`, `subtitle.resolve` (handled by `api`) and `subtitle.fetch`, `subtitle.ingest`, `subtitle.rank` (handled by `media`); **JustSubtitles (first)**, TMDB lookup, SubDL fallback mode, YIFY Subtitles, Assrt (Shooter), the assisted card for Zimuku, upload (a file becomes a candidate as soon as it's received); extraction, encoding, parsing, normalization, language detection; the candidate list, failed candidates and removal, "Add" (including Traditional/Simplified conversion, picking checkpoints, creating the sync doc), the list of added subtitles, removal; the remaining cards and tests on the Sources page, source status. The interface and workflow for "Auto-align and rank them all" are hooked up in this phase; the alignment itself uses the sync core's `autoAlign` for now (the next phase adds the ffsubsync half).

**The four sources and upload must all be finished together in this phase (D5).** The order is JustSubtitles → upload → YIFY → Assrt → Zimuku, but by the end of the phase every one must pass acceptance; none can be left for later.

**Acceptance**:
- Each source's parsing has unit tests built on recorded responses.
- The JustSubtitles entry that carries `api_key`: the URL stored in the database has no query string; the string can't be found in the logs.
- Make any one source fail (timeout, 500, wrong format, quota used up): the other sources' results appear as usual, and the failed one shows the reason and a retry.
- When JustSubtitles returns 500 for a nonexistent ID, it shows as "0 results" rather than an error.
- When Assrt is over quota it postpones automatically and shows the expected time; it does not retry back to back.
- Every kind of file in `fixtures/` (UTF-8, Big5, GB18030, UTF-16, ASS, VTT, zip) turns into the correct list of lines; language detection is correct; the Simplified-to-Traditional result matches the expected file.
- Every item about archives and outbound requests in the [12-auth.md](12-auth.md) checklist has a test.
- Zimuku: the code makes no request to it at all.
- Upload an unreadable file (a broken zip, a zip with no subtitles, an empty srt): a failed candidate row with the reason appears in the list and can be removed; no files are left behind.
- Two programs send requests to the same source at the same time: the requests still go out spaced apart (verified by having the fake source record the time it receives each request).
- `api` is restarted in the middle of a lookup: no source stays at "Searching…" forever.
- (When there are keys) go through the real sources by hand once: search, download, add. This is the second manual check D29 allows: download just one or two files per source, remove those candidates and subtitles once confirmed, and don't put the downloaded files in the repo. This time it's done through the site under development, so Brian enters the keys on the Sources page (not the three variables in `deploy/.env`; those are only for the Phase 0 scripts).

---

## Phase 6: sync workbench

**Read**: 09 (all of it), 08 (Auto-align), 03 (added subtitles, Transaction boundaries), 04 (subtitle docs, syncing, confirming), 11 (Workspace: Sync), 15 (Notes on browser tests).

**Do**: every feature of the workbench (the sync core was already moved into `packages/shared` in Phase 1); autosave and version conflicts; server-side auto-align (two methods, picking, consistency, results returning to `api` through `tasks`); confirming; showing other subtitles alongside; audio-only mode; virtualization of the subtitle lines; candidate ranking switching to full alignment.

**Acceptance**:
- Every item in [09-sync-workbench.md](09-sync-workbench.md) "Acceptance" is a Playwright test.
- The 17 sync core tests pass in `packages/shared`.
- Server-side auto-align on the three wrong subtitles matches the table in [08-media-pipeline.md](08-media-pipeline.md).
- Pressing "Auto-align" while ranking is running on thirty candidates: there is a result within a few seconds, without waiting for the ranking to finish.
- After confirming, re-marking only one checkpoint: the status stays confirmed; changing the offset: it goes back to draft.
- Two browsers change the same subtitles at the same time: the one that saves later sees an explanation of the conflict, and both choices work correctly.
- After reloading the page, the sync doc and the checkpoints' states are still there.
- With subtitles of more than a thousand lines (you can generate them by repeating the subtitles in `fixtures`): the list scrolls smoothly, and the timeline drags smoothly in whole-film view.
- If what Phase 0 measured on real films shows that changes are needed (thresholds, search range, whether to use both methods), handle them in this phase and update the docs.

---

## Phase 7: export

**Read**: 08 (Packing, Common rules for jobs, Reconciliation), 02 (Queues), 03 (Exports, What happens when a download is deleted), 10 (exports and storage, Confirmation wording), 04 (Export), 11 (Workspace: Export, Storage).

**Do**: the Export tab, creating an export (validation, admission, producing the final subtitles), the packing job (progress, cancel, two failed attempts and cleanup, checking after completion), the download endpoint (Range, file name), deletion (one approach each for queued, in progress, done and failed), the `export` event, notifications for exports finishing and failing, force deleting exports from the admin pages, your own exports on the Storage page.

**Acceptance**:
- Export `fixtures/clip.mp4` with two confirmed subtitles: the output's video and audio packets are exactly the same as the original file's; the language, title and default track of the two subtitle tracks are correct; the subtitle times equal the times computed from the sync doc (plus the offset shared by all tracks when packing).
- Changing or deleting the subtitles after export leaves the exported file unchanged.
- When there isn't enough space it can't start, and the message has numbers.
- Delete halfway through packing: ffmpeg is terminated, no file is left behind, and the reservation is freed.
- Resume a download after it's interrupted halfway; the final file is identical to the one on the server.
- After the film is deleted, the export is still there and can still be downloaded.
- A source with no audio track can still be exported.
- The Phase 7 group in [10-storage.md](10-storage.md) "Cases to test".

---

## Phase 8: admin and notifications

**Read**: 11 (Admin pages, notifications in the shell), 04 (Admin, notifications).

**Do**: the Overview page (including every kind of "Needs attention" source), the notification interface (bell, unread count, where clicking goes; earlier phases already write notifications to the table, so here fill in the kinds not yet produced; all six must exist), notifying the people affected after an administrator force deletes, items left with no holder after an account is removed, empty and error states not yet done on each page. Go through the 72 checks in `prototype/platform/e2e.cjs` and confirm each one has matching behavior and a test in production (for the one that doesn't apply, see [11-pages.md](11-pages.md)).

**Acceptance**:
- Every kind of "Needs attention" on the Overview page can be produced by a test and is displayed.
- Every kind of notification can be triggered, is displayed, and goes to the right place when clicked; when the target doesn't exist it goes to the Library, and export notifications go to the Storage page.
- Every page of the prototype exists in production, and none of the things that were "fake in the prototype" ([11-pages.md](11-pages.md)) came along.

---

## Phase 9: launch preparation

**Read**: 12 (Pre-launch checklist), 15 (Offline end-to-end flow, Tests that must exist), 16 (every item under Not yet verified; write the current conclusion for each), 02 (Configuration, Startup and shutdown, Outbound connections).

**Do**:
- An end-to-end test of the full flow (from search to downloading the MKV), using the fake YTS, local seeding and recorded source responses, with no network needed.
- The [12-auth.md](12-auth.md) checklist all passes.
- Deployment docs `docs/deploy.md`: requirements, every item in `.env`, how to open the port, the two ways to do HTTPS, how to update, **how to back up** (a database dump plus `/data`; backing up only one of them won't line up), how to move the whole site to another machine.
- A user guide `docs/guide.md` (in Traditional Chinese): going through the flow once in five minutes.
- Actually deploy once on the target machine. What you confirm yourself: all five containers are fine, the health check passes, the administrator can sign in, the settings pages can save, (when there is a YTS address) search and the film page show data, and the state of the incoming port. **Don't download films from YTS for acceptance** (rule 5 in `AGENTS.md`); run the full flow once on this machine with the offline test setup (fake YTS, local seeding) to confirm performance and disk; going through it for real is Brian's acceptance below.
- A final accessibility check: go through the main flow with the keyboard only; go through the main steps of the sync workbench with a screen reader.
- A security check of dependencies.

**Acceptance**: Brian installs it from scratch on his machine following `docs/deploy.md`, invites one person, and the two of them each complete the flow from search to getting an MKV once.

---

## Later

Not in these ten phases; done when Brian asks for them:

- Keeping ASS styles (D34; how to do it is in [09-sync-workbench.md](09-sync-workbench.md))
- Playing while downloading
- Previewing with the original file directly when the browser can play HEVC
- Letting users widen the auto-align search range
- Subtitle files that come with the torrent as a source
- Writing `zh-TW` / `zh-CN` language tags with `mkvpropedit`
- Merging two subtitles into one bilingual subtitle track
- Small subtitle clean-up tools (one-click removal of hearing-impaired markers and ad lines)
