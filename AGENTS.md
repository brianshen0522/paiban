# Working rules for the coding agent

In this folder you are implementing Paiban (拍板): a self-hosted website for searching films, downloading them, finding subtitles, lining the subtitles up in the browser, and finally producing an MKV with subtitles.

The spec, prototypes, reference code and test fixtures are already in this folder. **Read [docs/handover.md](docs/handover.md) first. It tells you where everything is and in what order to read it.**

The client is Brian. He reads and writes Traditional Chinese.

## Order of authority

When sources conflict, the earlier one wins:

1. What Brian says directly in the conversation
2. `docs/00-decisions.md`
3. The other documents in `docs/`: they govern the system's **behavior**
4. `packages/shared/src/contracts/api.ts`, `db/schema.sql`: they govern the **shape** of the data (endpoint list, fields, types, constraints)
5. `prototype/`: reference for screens, copy and interaction
6. `reference/`: reference for algorithms and commands (sync core, subtitle text processing, ffmpeg and ffsubsync commands, how to use WebTorrent)

Items 3 and 4 govern different things. When they truly don't match (a document mentions a field the contract doesn't have, or the contract has something no document explains), follow the documents for behavior, then complete the contract: change both together.

Items 5 and 6 are the same: the prototypes govern what you can see, the reference code governs what gets computed. The prototypes also contain a copy of the sync core (`core.js`); for that one, `packages/shared/src/sync-core/core.ts` is authoritative.

When you find a conflict or a gap: record it in `docs/agent-notes.md`. If the order above lets you decide, decide and write down why. If changing a decision in `docs/00-decisions.md` whose source is "Specified", "Decided for Brian" or "Assumption", or if you are unsure, stop and ask. Decisions whose source is "Handover" you may change first to what you think is better, but say so clearly in the report.

**The prototypes are a reference for behavior and screens, not for architecture.** Each is a single HTML file with everything crammed in, and the back end is entirely fake. Build what they look like and how they behave, not the way they are written.

## Things you must never do

None of these has an exception for "it's more convenient this way" or "the tests need it".

1. **Write no code that deletes user files automatically.** No scheduled clean-up, no retention period, no "clear out old ones when space runs low". Only one designated module may delete files under `/data` (WebTorrent's delete calls are also issued only from there), and every entry point corresponds to an action someone clicked (`docs/10-storage.md` lists the only few exceptions for clearing scratch files).
2. **Do not bypass CAPTCHAs, challenge pages or any mechanism that blocks automated access.** Don't pose as a browser, don't rotate headers or IPs, don't use a headless browser to scrape sites that block scrapers. When you hit one, mark that source unavailable.
3. **Do not use, store or log any API key that doesn't belong to Brian.** Keys that come along in third-party responses are dropped while parsing. When recording real responses by hand, replace the keys with `PLACEHOLDER` before writing to any file (including `.scratch/`).
4. **Torrents have exactly two ways in: YTS search results, and the "Add a torrent by hand" window** (a magnet link or a .torrent file; since 2026-10-09, specified by Brian, D26). A torrent added by hand keeps only its info hash, its filtered trackers and its info dictionary; web seeds and every other field are dropped, and only its largest video file (and the subtitle files beside it) is downloaded. The server never fetches a .torrent from an address on someone's behalf. There is no other way in (for example an API taking a bare hash, or importing from another site). (The standalone script phase 0 uses to understand network conditions is not part of the product; it only downloads the Blender Foundation's open movies.)
5. **Do not download copyrighted videos for development and testing.** Use `fixtures/`, the fake YTS and local seeding; when you need a real film, use the Blender Foundation's open movies. Automated tests also don't use subtitles downloaded from real sources. The only exceptions are the two manual source checks (phase 0 item 4, and the manual acceptance in phase 5): for each source, download the minimum number of subtitle archives, only to confirm the format; don't commit them and don't use them as test fixtures (D29). Phase 0's go in `.scratch/` and are deleted once looked at; phase 5's are fetched through the site under development, and once confirmed, those few candidates and subtitles are removed.
6. **Automated tests do not reach the outside network.**
7. **Never write a real key, password or token into the repo, logs, test fixtures or the conversation.** When you need Brian's key, ask him to fill it into the local `deploy/.env` or the admin pages himself. Passwords you generate for the local machine (database, `SECRET_KEY`, the first administrator) are written only into `deploy/.env`, which is not under version control; in reports and conversation, say only which variable, never the value. Fake values in test and development settings (fake keys, test account passwords) are exempt, but they must be obviously fake at a glance, e.g. `test-key-not-real`.
8. **Load no front-end resources from external domains** (fonts, scripts, images). The web page sends requests only to this site's own server; external links the user clicks open in a new tab (D30).

## Language

| What | Language |
| --- | --- |
| Code, identifiers, comments, commit messages, logs | English |
| All text users can see | Traditional Chinese (Taiwan usage) and English (since 2026-10-08, Brian), kept together in `apps/web/src/copy/`; components contain no strings in any language directly |
| The documents in `docs/` | English (since 2026-10-12, Brian) |
| Reports to Brian and conversation with Brian | Traditional Chinese |

The site name users see appears in only one constant (D9).

## How to work

- Follow the phases in `docs/14-plan.md`. **One phase at a time; when it's done, stop, report, and wait for Brian to say continue.**
- Before each phase, reread the documents that phase lists.
- Commit in small steps; every commit passes the type check, lint and tests. Commit messages explain why, not just what.
- Write a failing test first, then the implementation, especially for the categories in "Tests that must exist" in `docs/15-testing.md`.
- When you deviate from the spec, record in `docs/changes.md` what changed, why, and which documents are affected, and **change those documents too**. Spec and code disagreeing is worse than an imperfect spec.
- When you're unsure how a third party actually behaves, look it up or try it; don't guess. If what you find differs from the documents, update the documents.
- Report honestly: say what isn't finished is not finished, what isn't verified is not verified, and don't say tests passed when they didn't.
- Don't change a test's expected values to make it pass, unless you can explain why the original expectation was wrong.
- Don't add features the spec doesn't ask for. If you think of something worth doing, put it in the report's suggestions.

## Quality

When each feature is done:

- Types are complete, with no `any` escape hatches (except at third-party library boundaries, and those are wrapped)
- It has tests
- Loading, empty and error states all exist
- Error messages explain what happened and what can be done
- It can be operated by keyboard, and focus is visible
- No horizontal scroll bar at 400 px wide
- Both light and dark themes work
- The checklist in `docs/12-auth.md` is not violated

## How to use the reference code

Everything in `reference/` has actually been run and has tests:

- `pipeline/`: the ffmpeg and ffsubsync commands. Every option in the commands has a reason (written in `docs/08-media-pipeline.md`); don't add or remove options casually.
- `subtitles/text.mjs`: encoding, language detection, ASS conversion. Rewrite it in TypeScript and move the tests along with it.
- `torrent/local-swarm-test.mjs`: how to use WebTorrent and how to do offline tests.
- `providers/`: the shape of each source's responses. The JustSubtitles, YIFY and YTS ones are recorded real responses; the TMDB and Assrt (Shooter) ones are still **hand-written illustrations**. Once you have the address or key, replace them with `scripts/phase0/check-sources.mjs` (its README says which is which).

The sync core (`packages/shared/src/sync-core/core.ts`) and the API contract (`packages/shared/src/contracts/api.ts`) have already been moved from the handover pack into `packages/shared`, so the browser and the server share one copy. Before changing the sync core, make sure its 17 tests will still pass.

`packages/shared/src/contracts/api.ts` and `db/schema.sql` are the contract. You may change them, but change the corresponding documents with them and record it in `docs/changes.md`. `db/schema.sql` is also the database's first migration (applied when `apps/server` starts); see `docs/changes.md`.

## Commands

As the project grows, fill in the actual commands here and keep them up to date. By the end of phase 0 there are at least install, type check, lint, test and image build; end-to-end test and local development commands are added in the phase where they are built.

Requires Node.js 24, pnpm 12, Docker (with Compose v2).

```bash
pnpm install                                         # Install
pnpm typecheck                                       # Type check (TypeScript 7, strict)
pnpm lint                                            # Biome: lint + format check; pnpm format fixes in place
pnpm test                                            # Vitest for each package
pnpm build                                           # Build shared, server, web

pnpm db:test                                         # PostgreSQL for tests (port 55432); start it before pnpm test
pnpm dev                                             # Local development: database, fake YTS, fake subtitle source (8091), local seeding, api, torrent, media, web
                                                     # Open http://localhost:5173, sign in as admin / paiban-dev-not-real,
                                                     # and in "Sources" set the YTS address to http://127.0.0.1:8090

mkdir -p deploy/data                                 # First time: create the folder first, otherwise Docker creates it as root
docker compose -f deploy/docker-compose.yml build    # Build the images (paiban-server, paiban-proxy)
docker compose -f deploy/docker-compose.yml up -d    # Start the five containers; the address is PUBLIC_URL in deploy/.env
scripts/phase0/reference-in-image.sh                 # Run all reference tests and pipeline comparisons inside the image
pnpm test:image [file…]                              # Run server tests inside the image (the ones needing ffmpeg, ffsubsync, bsdtar or speech recognition are skipped on the host); run pnpm db:test first
pnpm test:image test/e2e-flow.test.ts                # Offline full flow (search → download → analyze → subtitles → sync → export → download MKV → delete), about 1.5 minutes
SEED_EXTRA_FILM=<path to a Blender open movie> pnpm dev  # In local development, one extra feature-length version (2160p) for walking through the full flow
```

Manual evaluation of auto-align (real videos, not part of automated tests): `apps/server/scripts/asr-eval.mts`; usage is at the top of the file. Deployment, updates and backups: see [docs/deploy.md](docs/deploy.md).

The phase 0 manual checks (not part of automated tests; they reach the outside network) are in `scripts/phase0/`, each file with usage at the top: `check-sources.mjs` (real subtitle sources), `real-swarm.mjs` (real BitTorrent download, Blender open movie), `real-film.sh` (alignment on a real film), `make-archives.sh` / `check-archives.sh` (archives), `playback/` (browser playback test page).

What you can run right now (to confirm the reference code works in your environment):

```bash
(cd reference/subtitles && npm ci && npm test)
(cd db && npm ci && npm test)
(cd reference/torrent && npm ci && npm test)                  # Two local clients transfer to each other; prints PASS on success
```
