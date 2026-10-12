# 16 Verified, unverified and risks

Some things in this spec have actually been run; others were written from documentation or inference. This document separates the two, so the implementer knows what can be relied on directly and what needs checking first.

## Actually verified

Done while preparing this handover pack, in a 2-core Linux sandbox (Ubuntu 24.04, Node 22.22 and 24.21, ffmpeg 6.1.1, Python 3.11 and 3.13). Everything in the "How to reproduce" column is in this folder.

| Fact | How to reproduce |
| --- | --- |
| WebTorrent 3.0.21 loads on Node 22 and 24 (including the uTP and WebRTC native modules); downloads from just an info hash; resumes using the bitfield; `skipVerify`; deleting files; rate limiting | `reference/torrent/` |
| `torrent.pause()` does not stop existing connections | WebTorrent official docs; source `lib/torrent.js` |
| The sync core's results in three scenarios; the effect of the search range; anchors; picking checkpoints | `packages/shared/src/sync-core/`, 17 tests |
| ffsubsync 0.5.1: why `--vad webrtc` is required, where the cache file is written, speech detection works without subtitles, re-aligning from the cache takes under a second | `reference/pipeline/analyze.sh`; [08-media-pipeline.md](08-media-pipeline.md) |
| ffsubsync's segmented mode is about 0.25 to 0.3 seconds early when subtitles stay on screen longer; it goes away after realigning | `fixtures/ffsubsync/`, `fixtures/expected.ffsubsync.json`, core test 13 |
| Combining and picking between the two alignment methods lands within 60 milliseconds on all three test subtitles, and the methods agree | `reference/pipeline/align.ts` |
| Time and size for the waveform, speech detection and audio file on a 2-hour file | The table in [08-media-pipeline.md](08-media-pipeline.md) |
| Preview file: the transcoding command with a bitrate cap; every frame's timestamp exactly equals the source's; no upscaling; it can still be made when the source has cover art or no audio track | `reference/pipeline/preview.sh` |
| Packing: video and audio packets identical to the original; language tags and default track; `0:V` is what keeps cover art from being treated as a video track; sources with no audio track can be packed; all tracks shift together; a Big5 file copied as a stream is silently packed as garbled text | `reference/pipeline/mux.sh` |
| Encoding detection (UTF-8, UTF-16, Big5, GB18030, Windows-1252), Traditional/Simplified detection, Simplified-to-Traditional conversion, ASS to plain text | `reference/subtitles/`, 5 tests |
| The database schema can be created; every case of usage and admission; the preview plan columns; the request queuing function; each constraint | `db/`, 11 tests (PGlite, PostgreSQL 18.3, single connection) |
| The API contract's types have no errors | `packages/shared/src/contracts/api.ts`, TypeScript 7.0.2 strict |
| The compose file's syntax, variable substitution, error messages for required variables | `docker compose config` (Compose v5.5) |
| The behavior of the two prototypes | `prototype/*/e2e.cjs`: workbench 40 checks, platform 72 checks |
| The JustSubtitles interface, the YIFY Subtitles page structure | Looked at in a browser on 2026-10-04; see the last section of [07-subtitle-providers.md](07-subtitle-providers.md) |
| Package versions | The npm registry on 2026-10-04 |

## Status after Phase 0 (2026-10-05)

For each item under "Not yet verified" below: what Phase 0 did and what it concluded. Details and numbers are in [reports/phase-0.md](reports/phase-0.md). The environment was the development machine (Debian 13, x86-64, 8 cores, 32 GB); whether the deployment machine is the same one isn't known yet.

| # | Item | Status |
| --- | --- | --- |
| 1 | Speech detection and auto-align on real films | **Partly does not hold.** *Tears of Steel*: ffsubsync's single offset is very accurate (within 0.034 seconds), but the sync core's segmented mode produces false breakpoints and gets picked; in the different-cut scenario both methods fail. *Sintel* (heavy music): webrtc detection can't pick up the dialogue, and everything fails. silero was tried and is incompatible with ffsubsync 0.5.1. Phase 6 needs to adjust |
| 2 | Reaching each source from the server | JustSubtitles and YIFY confirmed to work, with shapes matching the docs (two small differences fixed). TMDB, Assrt and SubDL have no keys, and YTS has no address: **not confirmed yet** |
| 3 | The image has never been built | **Confirmed.** It builds and the five containers come up; a few things were changed (`docs/changes.md`) |
| 4 | RAR extraction | **Confirmed** (RAR5, 7z, zip). No RAR4 sample to test |
| 5 | ARM | No ARM machine, **not confirmed** |
| 6 | Performance on the target machine | On the development machine: analysis takes 13 seconds for a 12-minute film and 18 seconds for a 15-minute one; two ffsubsync runs take about 2 seconds (0.7 seconds at handover). The deployment machine is still to be measured |
| 7 | Browsers playing directly | Confirmed to work in Playwright's Chromium (stereo and 5.1, `moov` at the end of the file, seeking works). Chrome, Firefox and Safari need Brian to open the test page |
| 8 | WebTorrent in the real world | **Confirmed** (short runs): inside a Docker bridge, DHT, uTP and trackers all work, and pause-and-resume and re-verification after a forced kill are correct. Long runs and large files not yet |
| 9 | Details written from memory | Tracker list: two were dead, fixed. Outer fields of the JustSubtitles title search: added. YTS genre parameter and Assrt `langlist`: not confirmed yet |
| 10 | Toolchain | TypeScript 7.0.2, Vite 8, Vitest 5 and Biome 2 are compatible on the skeleton. The `docker compose run` command has been run (`scripts/phase0/reference-in-image.sh`). Drizzle and pg-boss only come up in Phase 1 |
| 13 | Security advisories for dependencies | No change: webtorrent is still 3.0.21, and the `ip` 2.0.1 advisory has no fixed version |
| 14 | Score thresholds | The correct subtitles score 67% on *Tears of Steel*, and 30% of the lines are below 50%: the thresholds are too high; Phase 6 adjusts them |

## Not yet verified

Ordered by "how much it matters if it's wrong". This section is the original text from handover; for the current status see the previous section. Each item says in which phase it is confirmed and what to do if it doesn't hold.

### 1. Speech detection and auto-align on real films

**Current state**: all alignment numbers come from synthetic speech with very light background noise. Real films have music, sound effects, several people talking at once, and long stretches without dialogue.

**Risk**: speech detection counts music as speech, or misses quiet dialogue; the absolute scores and thresholds differ; auto-align finds the wrong position on some films. This is the most central feature of the whole product.

**Confirmation**: Phase 0 item 6, with Blender's open movies.

**If it doesn't hold**:
- The manual tools (anchors, offset, snapping, segments) don't depend on detection quality and can still get the subtitles synced, just with more work. The product still stands.
- ffsubsync has other detection methods (`--vad silero`, `fused`, which need torch installed separately and make the image much bigger; and transcription with whisper, which needs ffmpeg 8 and model files). Measure first, then decide whether it's worth it.
- When the two methods disagree, the interface already prompts the user to listen to a few more lines.

### 2. Reaching each source from the deployed machine

**Current state**: the sources' behavior was observed from an ordinary browser. They have never been hit with many requests from a server, the contents of no subtitle archive have been downloaded, and Assrt, TMDB and SubDL have never actually been called because there are no keys.

**Risk**: a source restricts non-browser requests, certain IP ranges, or request frequency; response fields differ from the docs; archive formats aren't what's expected.

**Confirmation**: Phase 0 item 4; the manual acceptance in Phase 5.

**If it doesn't hold**: that source is disabled or switched to assisted mode per D27. JustSubtitles has SubDL's official API as a fallback. Upload is always available.

### 3. The image has never actually been built

**Current state**: `deploy/Dockerfile.example` and `Caddyfile.example` were written from documentation and never run (the preparation environment couldn't reach Docker Hub and had no Caddy). Only the compose file's syntax was verified. `.dockerignore` hasn't actually been verified either.

**Risk**: package names, build steps or Caddy directive syntax are wrong. Also, the base image used by the example Dockerfile very likely ships an ffmpeg newer than 6.1.1, while the "exactly equal" comparisons in this spec (analysis results against `fixtures/data.json`) were made on 6.1.1; with a different version there may be a few frames of difference, and how to handle that is written in Phase 0 item 2.

**Confirmation**: Phase 0 item 1. This should be the first thing done.

### 4. RAR extraction

**Current state**: Chinese subtitle sites use RAR heavily. The example Dockerfile installs `libarchive-tools` (`bsdtar`), which claims to support reading RAR and RAR5, but it hasn't been tested, and the preparation environment had no tools to create RAR test files.

**Confirmation**: Phase 0 item 3.

**If it doesn't hold**: switch to another tool that can extract RAR (mind the license terms); or don't support RAR in the first version and ask users to extract before uploading. Assrt's API provides download URLs for individual files inside an archive, so it isn't affected.

### 5. ARM machines

**Current state**: everything was verified on x86-64. Many NAS devices are ARM.

**Risk**: if WebTorrent's native modules (`utp-native`, `node-datachannel`) and ffsubsync's dependency (`webrtcvad`) have no prebuilt versions for ARM64, build tools have to be installed in the image, or uTP turned off.

**Confirmation**: Phase 0, if Brian's machine is ARM.

### 6. Performance on the target machine

**Current state**: times were measured in a 2-core sandbox. The sync core's time on 1,500 lines (about 3 seconds) is an estimate, not measured.

**Risk**: a NAS CPU may be slower. Converting 2160p HEVC to a preview file may be slower than real time, taking several hours per film.

**Impact**: it only affects how soon the preview video is usable. Audio-only mode is usable within a few minutes, and syncing and export aren't affected.

**Confirmation**: Phase 0 items 5 to 6, Phase 4.

### 7. Browsers playing YTS files directly

**Current state**: no real YTS file has been tried in a browser. The assumption is that MP4 with 8-bit H.264 plus AAC can play directly (including 5.1 channels), and that it can also play via Range requests when `moov` is at the end of the file.

**Confirmation**: Phase 0 item 7 with a similar home-made file; real files only come up when Brian actually uses it.

**If it doesn't hold**: that kind of file also goes through the preview file. The decision rule lives in one function, so it's easy to change.

### 8. WebTorrent over long runs in the real world

**Current state**: only verified with two local clients transferring a 24 MB file to each other.

**Risk**: DHT and uTP on a Docker bridge network; memory use with multi-GB torrents; stability over several days of running; availability of unpopular torrents.

**Confirmation**: Phase 0 item 5, Phase 3; then observe in actual use.

**If it doesn't hold**: `torrent` is a standalone program that talks to the other parts only through the database. If it really doesn't work, it can be replaced with an adapter layer for another downloader without touching the other parts. This would violate D4 and needs Brian's agreement.

### 9. Details written from memory

| Item | Where |
| --- | --- |
| The list of public trackers | [05-yts.md](05-yts.md) |
| The exact form of the YTS genre parameter | [05-yts.md](05-yts.md) |
| The key name for `langlist` in Assrt responses | [07-subtitle-providers.md](07-subtitle-providers.md) |
| The outer fields of the JustSubtitles title search response | [07-subtitle-providers.md](07-subtitle-providers.md) |
| The examples in `reference/providers/` are all handwritten shapes | `reference/providers/README.md` |

Correct them all once Phase 0 records real responses.

### 10. Toolchain

- TypeScript 7 is very new; whether Drizzle, Vite plugins and Vitest are all compatible hasn't been tried. If not, use 5.x.
- The API details of pg-boss 12 (queue concurrency settings, retries, not queuing the same key twice) haven't actually been used; the docs only describe the behavior needed.
- Writing BCP 47 language tags with `mkvpropedit`: not tried, already listed under "Later" in [14-plan.md](14-plan.md).
- The `docker compose run` command in Phase 0 item 2 has never been run (the preparation environment had no Docker).

### 11. Database behavior with many simultaneous connections

**Current state**: `storage_admit` (space check) and `provider_take_slot` (request queuing) were both tested on embedded PostgreSQL, but that is a single connection, so it can't test "two connections calling at once". They rely on advisory locks and row locks, which are correct in theory at the default isolation level (READ COMMITTED).

**Confirmation**: Phase 3's "two downloads competing for the last bit of space" and Phase 5's "two programs sending requests to the same source at the same time" tests are exactly what verifies them, with a real PostgreSQL and multiple connections.

### 12. Flows in this spec with no prototype to compare against

Claiming and reconciling background jobs, automatically retrying once after a failure, deletion not waiting for jobs (the job stops on its own and cleans up its own output), uploaded files first becoming a candidate, outbound lookups done as jobs: these designs were added when the spec was filled out. They've been checked against each other logically, but none of them has actually been run. If, during implementation, you find a simpler approach with the same behavior, you can propose it (they aren't "Specified" or "Decided for Brian" decisions).

### 13. Security advisories for dependencies

On 2026-10-05, running `npm audit` on `webtorrent` 3.0.21 reported 4 high-severity issues, all from the same source: the `ip` package (GHSA-2p57-rm9w-gvfp, `isPublic` misjudges certain addresses), pulled in through `bittorrent-tracker` and `torrent-discovery`. The "fix" `npm audit` suggests is downgrading to a very old webtorrent, which isn't feasible.

This spec hasn't assessed its actual impact for this use. To do:

- Our own code for blocking internal addresses **must not use the `ip` package** ([12-auth.md](12-auth.md)).
- In Phase 0, check the current state once (whether there's a new webtorrent, whether the advisory has a fixed version).
- The dependency check in Phase 9 must reach a clear conclusion on this item: upgrade, replace, or explain why it isn't a problem here.

**Conclusion (2026-10-06): not a problem here.** `pnpm audit --prod` reports only this one item (`ip` has no fixed version). In `bittorrent-tracker` 11.2.3, only `lib/server/parse-udp.js` (the tracker **server side**, which parses UDP announces sent by others) imports `ip`; we only connect to trackers as a client and never start a tracker server, so that code is never loaded or run. Our own blocking of internal addresses uses Node's built-in `net.BlockList` (`apps/server/src/net/address.ts`), not `ip`. Check again when webtorrent releases a new version.

### 14. Score thresholds

70% / 55% (whole film) and 50% / 25% (single line) come from the prototype's observations on synthetic material. Correct subtitles score 80% (subtitles that stay on longer) to 95% (subtitles that equal the speaking intervals) on synthetic material. The distribution on real films is unknown. Adjust after Phase 0 item 6 measures it.

## Known design limitations

Not problems; choices. Users may ask about them.

| Limitation | Reason |
| --- | --- |
| JustSubtitles returns at most 30 results per language | That's how its interface works. English subtitles for popular films will be incomplete; YIFY Subtitles can fill the gap |
| Auto-align can't find gaps of more than 60 seconds | The search range. The user can fix it by placing two anchors |
| The sync core finds only one breakpoint | Two or more breakpoints rely on ffsubsync's segmented mode, or manual segments |
| ASS styles and effects are stripped | D34 |
| Image-based subtitles (VobSub, PGS) aren't supported | They aren't text, so they can't be synced |
| Subtitles and sync results are shared; each person can't have their own copy | "Once someone has synced it, everyone else can just use it" matters more. For a different version, add another subtitle track |
| Lowering the number of concurrent downloads doesn't pause ones already running | To avoid interrupting something halfway |
| Resetting a password requires an administrator | The system doesn't send email |
| Can't search by Chinese title | YTS only recognizes English titles. Chinese titles are only for display (they exist only with a TMDB key, and only after someone has searched subtitles for that film) |
| Administrators can't directly work on other people's films | Permissions only look at whether you're a holder. An administrator adds the film to their library first, or uses force delete |
| An export takes as much space as the original file | The cost of not re-encoding. Deleting it after downloading frees the space |

## Things for Brian to confirm

These were decided only at packing time, and he hasn't seen them yet. Each has a reasonable default and won't block starting work, but please raise them again in the Phase 0 report.

| Item | Current default | Alternative |
| --- | --- | --- |
| Decisions whose source is "Handover": D18, D25, D30 to D41 | See [00-decisions.md](00-decisions.md) | |
| Administrators handling other people's films (syncing subtitles, pausing downloads) | First add that version to their own library, then act like any other holder; to stop someone else's download, use force delete. Matches the prototype | Administrators can directly work on anyone's film |
| When the "download finished" notification is sent | The moment the download finishes (subtitles can already be searched at that point) | Wait until audio analysis is done (the prototype's approach, about a minute later) |
| Background job failures | Retry once automatically; show the failure only if it fails again | No automatic retry |
| Searching by Chinese title | Not done (YTS only recognizes English titles) | Later, map Chinese titles via TMDB |
| How Simplified is converted to Traditional | Both characters and terms are changed to Taiwanese usage (软件 → 軟體, "software") | Change characters only, not terms |
| Seeding | Stop as soon as the download finishes | Seed to a share ratio of 1.0 |
| Upload rate limit | 512 KB/s | |
| Concurrent downloads | 2 site-wide, 2 per person | |
| Members can see other members' names (on shared films) | Yes | Anonymized as "someone else" |
| Can members delete subtitles someone else added | Yes (subtitles are shared for the film) | Only the person who added them and administrators can delete |
| Default resolution of the preview file | 480p | 720p |
| Punctuation in interface copy | Full-width commas, colons, semicolons and parentheses, see [17-ui.md](17-ui.md) | Half-width, as in the prototype |

## Legal

Not legal advice. Most content on YTS isn't authorized by the rights holders, and BitTorrent uploads while it downloads. In most places, using it this way carries legal risk, borne by whoever sets it up and uses it. This spec does a few things technically to reduce accidents (only accepting YTS hashes, stopping uploads as soon as a download finishes by default, no open registration), but they don't change the above.

Development and testing never need to, and should not, download copyrighted video. The only contact with real subtitles is the two manual source checks, downloading one or two archives per source to look at the format, deleted once looked at (D29).
