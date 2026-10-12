# Paiban (拍板): implementation handover pack

Paiban is a self-hosted website: search for films, download them, find subtitles, line the subtitles up in the browser, and finally produce an MKV with subtitles.

This folder holds everything needed to start implementing: the spec, prototypes you can operate, reference code that has been run, and test fixtures. **There is no product code here yet**; this is the starting point of the project, and what gets implemented grows directly in this folder.

## Brian: how to start

1. Put this folder where you'll develop (it becomes the project's repo). That machine needs Docker, network access, git and Node.js; ideally it's the same machine you'll host the site on. Details are in "Before you paste" in [PROMPT.md](PROMPT.md).
2. Open your coding agent in this folder.
3. Paste the getting-started prompt from [PROMPT.md](PROMPT.md) to it.

It will first read the documents, run the reference tests once inside the image, check the real sources, and then stop and report to you. Every phase after that works the same way: do it, report, wait for you to say continue. `PROMPT.md` also has the sentences to paste for later phases.

If you want to see what's being built first: open `prototype/platform/index.html` in a browser.

Some defaults were set while preparing this handover pack (seeding, speed limits, how many films download at once, the scope of administrator permissions…); they're listed in "Things for Brian to confirm" at the end of [docs/16-risks.md](docs/16-risks.md). Take a look when you have time; not looking won't block the start, and the coding agent will ask again in its first report.

## What's in the folder

| Path | Contents |
| --- | --- |
| `PROMPT.md` | The getting-started prompt to paste to the coding agent, plus the ones for later phases |
| `AGENTS.md` | Working rules for the coding agent. Most tools read it automatically (`CLAUDE.md` just includes it) |
| `docs/` | The spec, 18 documents. See the reading order below |
| `packages/shared/src/contracts/api.ts` | The API contract: request and response types for every endpoint, error codes, live events |
| `db/schema.sql` | The database's reference schema, including functions for usage calculation and space checks; `schema.test.mjs` is its test |
| `deploy/` | Examples of Docker Compose, Dockerfile, Caddyfile, `.env` |
| `prototype/platform/` | Operable prototype of the whole platform (a single HTML file), source, 30 screenshots, automated checks |
| `prototype/workbench/` | Standalone prototype of the subtitle sync workbench, same as above |
| `packages/shared/src/sync-core/` | TypeScript implementation of the sync core with 17 tests. Becomes part of the product directly |
| `reference/pipeline/` | Runnable scripts for analysis, preview files, alignment, packing |
| `reference/subtitles/` | Subtitle encoding detection, Traditional/Simplified conversion, ASS conversion, with tests |
| `reference/torrent/` | Offline WebTorrent test: two local clients transfer to each other |
| `reference/providers/` | Sample shapes of each external source's responses (hand-written illustrations, not real responses) |
| `fixtures/` | Test fixtures: a synthetic 92-second video (three encodings), correct and deliberately wrong subtitles, assorted encodings and formats, real ffsubsync output |
| `.gitignore`, `.dockerignore`, `.gitattributes` | Settings the project should have from the start: what stays out of version control (`.env`, `/data`, the `.scratch/` used when checking sources by hand), what stays out of the image, and keeping git from changing line endings in test fixtures |

## For the coding agent: reading order

Read `AGENTS.md` first, then read `docs/` in this order. The first five give the overall picture; read the rest closely when you reach that part.

| Order | Document | Contents |
| --- | --- | --- |
| 1 | [00-decisions.md](docs/00-decisions.md) | Settled decisions and their sources. **Highest authority** |
| 2 | [01-product.md](docs/01-product.md) | What this is, who uses it, the main flow, the glossary |
| 3 | [02-architecture.md](docs/02-architecture.md) | Five containers, how they communicate, disk and code layout, technology choices |
| 4 | [14-plan.md](docs/14-plan.md) | Ten phases and each phase's acceptance criteria |
| 5 | [16-risks.md](docs/16-risks.md) | What has been verified, what hasn't, what Brian needs to confirm |
| 6 | [03-data-model.md](docs/03-data-model.md) | Tables, how state changes, transaction boundaries |
| 7 | [04-api.md](docs/04-api.md) | Behavior of every endpoint, live updates, error codes |
| 8 | [10-storage.md](docs/10-storage.md) | Storage limit rules (no automatic deletion) |
| 9 | [05-yts.md](docs/05-yts.md) | YTS integration |
| 10 | [06-torrent-worker.md](docs/06-torrent-worker.md) | The downloader |
| 11 | [08-media-pipeline.md](docs/08-media-pipeline.md) | Analysis, preview files, auto-align, packing |
| 12 | [07-subtitle-providers.md](docs/07-subtitle-providers.md) | Four subtitle sources and uploads |
| 13 | [09-sync-workbench.md](docs/09-sync-workbench.md) | The sync workbench |
| 14 | [11-pages.md](docs/11-pages.md) | Every page: data, states, copy, differences from the prototype |
| 15 | [12-auth.md](docs/12-auth.md) | Accounts, permissions, security |
| 16 | [13-settings.md](docs/13-settings.md) | Settings items and validation |
| 17 | [15-testing.md](docs/15-testing.md) | Testing strategy, the offline end-to-end flow |
| 18 | [17-ui.md](docs/17-ui.md) | Color, type, components, copy rules |
| 19 | [18-llm.md](docs/18-llm.md) | Language model profiles (load balancing, fallback) and subtitle translation |

Three things get added during implementation: `docs/agent-notes.md` (questions and judgment calls), `docs/changes.md` (deviations from the spec), `docs/reports/` (each phase's report). See each file for its format.

## How far this spec can be trusted

Actually run during preparation:

- The sync core (17 tests), subtitle text processing (5), database usage and space checks (11), WebTorrent download and resume (Node 22 and 24)
- Every ffmpeg and ffsubsync command, and their results on the test fixtures
- The API contract's types, the compose file's syntax
- Behavior of the two prototypes (40 checks for the workbench, 72 for the platform)
- The JustSubtitles and YIFY Subtitles interfaces (viewed in a browser on 2026-10-04)

Not yet verified, to be confirmed in the first phase (the full list is in [16-risks.md](docs/16-risks.md)):

- **How accurate auto-align is on real films.** All current numbers come from synthetic speech
- Actually reaching each subtitle source from the hosting machine; Assrt (Shooter), TMDB and SubDL have never actually been called because there are no keys
- The Dockerfile and Caddyfile have never actually been built
- The extraction tool for RAR archives
- ARM machines
- Scheduling details of background jobs (claiming, reconciliation, one automatic retry): checked logically, never actually run

## What Brian needs to prepare

You don't need everything up front; the coding agent will ask when it reaches the phase that needs it. The list is in [14-plan.md](docs/14-plan.md). The earliest needed:

- Specs of the deployment machine (CPU, memory, disk, x86 or ARM)
- A YTS address that currently works
- A TMDB API key (free to apply for)
- An Assrt (Shooter) API token (obtained after registering)

Please fill keys in yourself, into the local `deploy/.env` (used for checking sources by hand during development) or the admin pages after launch (used by the running site). Don't paste them in the conversation.

## Legal note

Not legal advice. Most content on YTS isn't authorized by the rights holders, and BitTorrent uploads while it downloads; in most regions this kind of use carries legal risk, borne by whoever hosts and uses it. Development and testing use only the synthetic fixtures included here and freely distributable videos throughout.

## License

[MIT](LICENSE). The license covers this code only; it grants nothing about any film, subtitle or other content the software downloads.
