# Reference code

Everything here has actually been run. The sync core that used to be here (`sync-core/`) has moved to `packages/shared/src/sync-core/`. None of this is the product; it's a starting point so implementation doesn't have to feel its way from scratch: some of it moves straight into the project, some of it demonstrates an approach.

| Folder | Contents | How to run | How it's used later |
| --- | --- | --- | --- |
| `pipeline/` | `analyze.sh` (probe, waveform, speech), `preview.sh` (audio file, preview file), `mux.sh` (packing), `align.ts` (the complete auto-align flow), `peaks.mjs`, `npz_to_speech_json.py` | Needs ffmpeg and a Python with ffsubsync 0.5.1 installed (point the environment variables `FFSUBSYNC` and `FFS_PYTHON` at the executables in the virtual environment). Each file has usage at the top | The logic is rewritten into the `media` program; the command options are used as they are |
| `subtitles/` | Bytes to text (encoding), detecting language and Traditional/Simplified, Simplified-to-Traditional conversion, ASS to plain text. 5 tests | `cd subtitles && npm ci && npm test` | Rewritten in TypeScript, with the tests moved along |
| `torrent/` | Offline WebTorrent test: downloading from just an info hash, pausing and resuming, deleting | `cd torrent && npm ci && npm test` | The basis for how the `torrent` program works; integration tests seed the same way |
| `providers/` | The shape of each external source's responses | Data only | Replaced with real responses in phase 0, then used as test fixtures |

Test fixtures are in `../fixtures/`. Why each command is written the way it is: `../docs/08-media-pipeline.md`.

Test environment: Ubuntu 24.04, 2 cores, Node 22.22 and 24.21, ffmpeg 6.1.1, Python 3.11 and 3.13, ffsubsync 0.5.1, webtorrent 3.0.21, TypeScript 7.0.2.

The `.ts` files were checked with these settings: `strict`, `module` and `moduleResolution` set to `NodeNext`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noUnusedLocals`, `noUnusedParameters`. `noUncheckedIndexedAccess` is not on; to turn it on, the sync core needs a round of changes first (it produces a few dozen more errors).

The three folders with a `package.json` each include a `package-lock.json`; install with `npm ci`. The webtorrent installed by `torrent/` brings in a dependency with a security advisory; see `../docs/16-risks.md`.
