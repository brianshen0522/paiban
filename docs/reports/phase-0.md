# Phase 0 report: check the assumptions

2026-10-05. The environment is the dev machine: Debian 13 (trixie), x86-64, 8 cores, 32 GB of memory, 125 GB of disk (90 GB free), Docker 29.8.2, Compose 5.6.0, with outbound access. Whether the deployment machine is this one isn't known yet, so the network and performance conclusions below are **results from the dev machine**.

## Conclusion

Phase 0 is done: the skeleton and the five containers come up, the reference tests all pass in the image, and real BitTorrent downloads, subtitle sources, archives and browser playback have been checked; YTS, TMDB, Assrt and SubDL are **not yet confirmed** because there's no URL or key.

**The most important thing for you to know: auto-align performs worse on real films than the spec expected.** On *Tears of Steel*, ffsubsync's single offset is accurate, but the spec's "segment" approach produces false breakpoints that get chosen every time, so the result is wrong; on *Sintel*, which has a heavy score, speech detection doesn't pick up the dialogue at all. The product still holds up (the manual tools don't depend on detection), but phase 6 needs to adjust auto-align; numbers and suggestions are below.

Nothing blocks phase 1.

## Findings that could shake the architecture

No findings change the architecture (WebTorrent works in Docker, the image builds, ffmpeg 7.1.5 and 6.1.1 give identical results). The closest is the auto-align issue above, which affects the phase 6 algorithm and how the interface describes it, not the architecture.

### Auto-align on real films (item 6)

Method: take the official English subtitles as the correct answer, break them the same way as in `fixtures/` (as is, 2.4 seconds late, 23.7 seconds late, frame rate 25→23.976, 12 seconds missing in the middle), run the full auto-align on each (`reference/pipeline/align.ts`: ffsubsync in two modes + the sync core + selection), and measure how far each line's start time is from the correct answer. Scripts: `scripts/phase0/real-film.sh`, `real-film-align.ts`.

**Tears of Steel** (12 minutes, 76 lines, 48% speech detected):

| Scenario | Finally chosen | Error of the chosen result | ffsubsync single offset | Sync core |
| --- | --- | --- | --- | --- |
| As is | Sync core (two segments) | Median 0.03 s, but **17 lines off by 37.8 s** | All within 0.03 s | Same as left (wrong) |
| 2.4 s late | Sync core (two segments) | Same as above | All within 0.03 s | Same as left (wrong) |
| 23.7 s late | Sync core (two segments) | Median 0.03 s, 21 lines off by 79 s | All within 0.03 s | Same as left (wrong) |
| Different frame rate | Sync core (two segments) | Median 0.034 s, 17 lines off by 37.8 s | All within 0.034 s | Same as left (wrong) |
| 12 s missing in the middle | Sync core (two segments) | Half the lines off by 12 s or more | Half off by 11.9 s (only finds one segment) | Breakpoint and offset both wrong |

- When the sync core is allowed to segment, it always splits off the last 17 lines as a separate segment and moves them 38 seconds earlier (where there happens to be other speech). That scores higher (71.7% vs. 67.2%), and the penalty of 3 seconds of dialogue per extra segment doesn't stop it, so the selection logic picks it every time, with `agree` false.
- **With segmentation turned off**, the two methods agree exactly, the offset is 0.03 seconds, and `agree` is true.
- The correct subtitles score 67%: under the current thresholds (70% green, 55% yellow) they'd show yellow; 22 of the 76 lines are below 50% and 5 below 25%. The thresholds are too high.

**Sintel** (15 minutes, 26 lines, heavy score, quiet dialogue): the "speech" webrtc detects covers only 14%, and most of it isn't dialogue: the correct subtitles score only 20%. Both methods got all five scenarios wrong (median error 12 to 79 seconds).

**Another speech detector (silero)**: ffsubsync's `--vad silero` needs torch installed separately, a 5.3 GB environment; it runs to completion, but the whole output is 0. ffsubsync 0.5.1 is incompatible with the current silero-vad model, and no meaningful result was obtained. That environment has been deleted.

**My suggestions** (handled in phase 6, not affecting phases 1 to 5):
1. Make segments harder to justify: a segment needs a minimum number of lines and must be clearly better than a single offset, and the penalty should scale with film length; when the two methods disagree, prefer fewer segments. Use these two films as regression tests (only the speech data and subtitle timings; the videos don't go into the repo).
2. When `agree` is false or the score is very low, the interface should say plainly "Auto-align isn't reliable; please set two anchors", rather than only showing the score.
3. Whether to invest in another speech detector (fix silero's compatibility, or transcribe with whisper) is your decision: it would make the image several GB larger and use more CPU (see "To decide" at the end).

## What was done

- **Read the spec.** The README, AGENTS and the 18 documents in docs/. Of those, I read 00, 01, 02, 05, 06, 07, 08, 10, 12, 14, 15 and 16 word for word; the item-by-item cross-check of 03, 04, 09, 11, 13, 17 against the contract and schema was handed to an assisting review process, and I spot-checked three of its findings (all accurate). Results are recorded in `docs/agent-notes.md`.
- **Looked at the prototypes.** Both prototypes were actually operated with Playwright's built-in headless Chromium (this machine has no Chrome and no display, and the MCP browser tools wouldn't start): every page, the workbench's auto-align, checkpoints, keyboard shortcuts, 400 px and the dark theme. The prototypes' own checks: platform 72/72, workbench 40/40 passed. This step was also done by the assisting process and reported back to me; I didn't click through it myself.
- **Skeleton.** A pnpm monorepo: `apps/server` (three entry points: `api`, `torrent`, `media`), `apps/web` (one page showing the site name), `packages/shared` (the site name constant). TypeScript 7.0.2 strict, Biome (lint and formatting), Vitest. `api` has `GET /api/health`; `torrent` and `media` write a log line every minute; the three programs refuse to start under `NODE_ENV=production` if test variables are set.
- **Deployment files.** The three example files became real files and were actually built; the changes are in `docs/changes.md`.
- **`deploy/.env`.** Copied from the example, with the database password, `SECRET_KEY` and administrator password generated randomly and the administrator username set to `admin`. Also, because port 8080 on this machine is already used by another project (forward), the local `HTTP_PORT` was changed to 8088, `HTTPS_PORT` to 8448, and `PUBLIC_URL` is `http://localhost:8088`.
- **Phase 0 scripts**, all in `scripts/phase0/`, each with usage at the top: reference tests in the image, checking real sources, a real BitTorrent download, alignment on real films, archives, and a browser playback test page.
- **Documents.** Everywhere that differed from reality was fixed (the tracker list, two points about JustSubtitles, Playwright and H.264, the ffmpeg version, the archive fixtures); `docs/16-risks.md` now has each risk's status after phase 0; the "Commands" section in `AGENTS.md` is filled in.

## Acceptance

| Criterion | Result |
| --- | --- |
| `docker compose up --build` succeeds in one go and health checks pass | **Passed.** All five containers are up with no restarts; `GET /api/health` returns `{"ok":true}`; the page shows "拍板" (Paiban, the site name; no horizontal scroll bar at 1280 px light or 400 px dark, no console errors); Caddy adds the security headers. The first attempt failed because Docker created `deploy/data` as root and the services couldn't write to it; this is fixed and noted in `.env.example` |
| Every test in item 2 passes in the image, with numbers matching the docs | **Passed.** See item 2 below |
| The report has a clear conclusion for each of items 3 to 7 | See the next section |
| Findings that could shake the architecture are written first | There are none that shake the architecture; the auto-align issue is written first |

### Item 1: skeleton and image

Actual versions in the image: Node 24.21.0, **ffmpeg 7.1.5** (Debian trixie; the spec's numbers were measured on 6.1.1), Python 3.13.5, ffsubsync 0.5.1, bsdtar 3.7.4 (libarchive 3.7.4). `api`, `torrent` and `media` share one image, `paiban-server` (1.23 GB); the web front is `paiban-proxy` (93 MB).

### Item 2: reference tests in the image

`scripts/phase0/reference-in-image.sh` (about 2 minutes):

| Item | Result |
| --- | --- |
| `reference/sync-core` | 17/17 |
| `reference/subtitles` | 5/5 |
| `db` | 11/11 |
| `reference/torrent` | PASS |
| `analyze.sh` on `clip.mp4` | `speech.json` and `data.json` are **identical** (42 regions, 9,242 frames, 0 frames different); `peaks.bin` is byte-for-byte identical. No difference between ffmpeg 7.1.5 and 6.1.1; no need to loosen the comparison |
| `align.ts` on three subtitle files | Late: one segment ×1 −2.36; frame rate: one segment ×1.04271 −0.791; cut: two segments +1.25 / +13.24; `agree` is true for all three. Matches the table in 08 |
| `preview.sh` on `clip.hevc10.mp4` | `audio.m4a` (AAC stereo) and `proxy.mp4` (H.264 yuv420p 480×270 + AAC stereo); the timestamps of all 2,214 frames are identical to the source |
| `mux.sh` | One video, one audio and two subtitle tracks; `chi` "繁體中文" is the default track, `eng` "English" is not; the video and audio packet hashes are identical to the source |

One small difference: the two ffsubsync runs together take about 2 seconds, while the handover measured 0.7 seconds (doesn't affect the conclusion).

### Item 3: archives — **confirmed**

In a temporary Debian container, RARLAB's `rar` 7 and `7zip` were used to make RAR5 and 7z versions of `archive.zip`, plus seven archives that should be rejected, placed in `fixtures/archives/` (the tools that generate them don't go into the product image). bsdtar in the image extracts zip, 7z and RAR5, all with contents identical to `archive.zip`.

- **RAR4 is not confirmed**: the current `rar` 7 can no longer write RAR4, so there's no sample. libarchive has supported RAR4 far longer than RAR5, so the risk is low.
- bsdtar on its own only rejects entries containing `..` (it extracts everything else) and strips a leading `/`; **symlinks are extracted as is, and there's no limit on count or size**. So the checks required by 07 and 12 must be done by the program itself (list first and then decide, and count the bytes actually written while extracting). This matches what the spec requires; it just confirms the tool can't be relied on.

### Item 4: real external sources — **partly confirmed**

`scripts/phase0/check-sources.mjs` sends only a few requests per source; responses are stored in `.scratch/` (not committed), and keys are replaced with `PLACEHOLDER` before being written to any file.

| Source | Conclusion |
| --- | --- |
| JustSubtitles | **Confirmed, with two differences.** Responds normally to server-side requests (`User-Agent: Paiban/…`, no disguise). Fields match the docs; `EN` 30 items, `ZH` 7, `ZH_BG` 3. **A nonexistent ID returns 200** (the docs said 500); title search's outer shape is `{results: [...]}` (the docs said it wasn't recorded). Every URL in `ZH` and `ZH_BG` carries someone else's `api_key`, and downloads still succeed with it removed. One archive downloaded: a zip with one UTF-8 Traditional Chinese `.srt` (in the `ZH` category, which is nominally Simplified) |
| YIFY Subtitles | **Confirmed.** The page structure, the base64 of the download button and the download host all match the docs; no CAPTCHA or challenge page. Archive: a zip with one UTF-8 (with BOM) Traditional Chinese `.srt` |
| YTS | **Could not confirm**: no URL |
| TMDB | **Could not confirm**: `TMDB_KEY` is empty |
| Assrt | **Could not confirm**: `ASSRT_TOKEN` is empty |
| SubDL | **Could not confirm**: `SUBDL_KEY` is empty |

Both archives were deleted after inspection. The recorded JustSubtitles and YIFY responses have been put into `reference/providers/`, replacing the hand-written samples (an analytics service's `token` in the YIFY page was also replaced with `PLACEHOLDER`). Once the URL or keys are provided, run `node scripts/phase0/check-sources.mjs --only <yts|tmdb|assrt|subdl>` (for YTS, `YTS_BASE_URL=https://… node …`) to complete the check.

### Item 5: real BitTorrent download — **confirmed** (dev machine, short run)

`scripts/phase0/real-swarm.mjs`, run in a container from the `paiban-server` image, on a Docker bridge network, publishing 51413 (TCP/UDP) and 51414 (UDP), the same as the real deployment. The torrents come from WebTorrent's official docs (`webtorrent.io/docs` and `/free-torrents`): *Sintel* (129 MB) and *Tears of Steel* (571 MB), both Blender Foundation open movies. The HTTP webseeds in the official magnet links were deliberately removed, so data could only come from BitTorrent peers.

| | Sintel | Tears of Steel |
| --- | --- | --- |
| Got torrent info | 8.1 s | 3.6 s |
| Speed | Up to about 4 MB/s, a dozen or so peers | Up to about 5.8 MB/s |
| Pause (save bitfield, destroy) and resume | Ready in 3 s, all 301 pieces intact | Ready in 3.2 s, all 263 pieces intact |
| Restart after a forced kill (SIGKILL), no bitfield given | Re-verified in 4.5 s, resumed to completion | Re-verified in 5.1 s, resumed to completion |
| Total | 1.6 minutes | 2.9 minutes |

- **DHT**: works, with 15 to 60 nodes within seconds. **uTP**: works; most connections are outgoing uTP.
- **Trackers**: `opentrackr` and `demonii` respond; `tracker.openbittorrent.com` has no DNS record and `p4p.arenabg.com` times out. The list in 05 has been changed.
- **Incoming**: the Sintel run saw 1 `utpIncoming` and 0 `tcpIncoming`. uTP runs over UDP, and after we connect out, NAT temporarily lets the other side connect back, so this one doesn't prove the port is forwarded. Suggestion: "incoming connections" should look only at `tcpIncoming` (recorded in agent-notes, to be handled in phase 3).
- Memory usage over long periods (several days) with multi-GB torrents is **not yet confirmed**.

### Item 6: alignment on a real film — **does not match**

See the top of this report. Analysis time itself: 13 seconds for the 12-minute film, 18 seconds for the 15-minute film (8 cores).

### Item 7: browser playback — **partly confirmed**

ffmpeg was used to make two YTS-like files from *Tears of Steel*: H.264 High, yuv420p, AAC stereo, and the same video with AAC 5.1; both have `moov` at the end of the file (`ftyp free mdat moov`). `scripts/phase0/playback/serve.mjs` is a minimal endpoint that only handles Range (206, 416); the test page automatically loads, plays, seeks to 10:00, and seeks back to 0:30.

| Browser | Result |
| --- | --- |
| Playwright's built-in Chromium 153 (headless) | **Both files fully pass**: metadata loads in 0.1 to 0.2 seconds (`moov` at the end isn't a problem), plays, seeks in about 2.3 seconds, audio is decoded. The frames are actually decoded. This differs from the spec's "built-in Chromium can't decode H.264"; the docs have been changed |
| Chrome, Firefox, Safari | **Could not confirm**: this machine has no desktop browser. Playwright's WebKit is missing system libraries (installing them needs sudo), and it isn't the same as Safari anyway |

Please open the test page once each in Chrome, Firefox and Safari (Mac or iPhone), press "Start", and paste me the text in the gray box at the bottom (steps in the last section).

## Tests

| What was run | Result |
| --- | --- |
| `pnpm typecheck` / `pnpm lint` / `pnpm test` | Passed. 6 tests (site name constant 1, health check 1, startup check for test variables 3, page shows the site name 1) |
| The four reference test suites (on the host) | 17, 5, 11, PASS |
| `scripts/phase0/reference-in-image.sh` (in the image) | The four suites as above + pipeline 12/12 |
| Archives, sources, BitTorrent, real films, playback | Run by hand; results in each item above |

## Differences from the spec

Five entries in `docs/changes.md` (2026-10-05): Playwright and H.264, the default tracker list, the two points about JustSubtitles, the archive test fixtures, and the fixes to the deploy files.

## Problems and risks found

- **Auto-align** (at the top).
- **Spec contradictions found during cross-checking**: the full list is in the last entry of `docs/agent-notes.md`. Four can't be implemented as literally written: `media_files.error` has only one slot, so errors overwrite each other (phase 4); broadcast events contain fields that differ per recipient (phases 1, 3); the responses for pause / resume / download don't show whether the item will be queued (phase 3); the source error codes are missing `INVALID_KEY` (phase 5). I can decide all of these following the order in AGENTS.md, and will change the docs and contract when I reach those phases.
- **D34 (Handover) runs into D6 (Specified)**: the first version drops ASS styles and positioning. Many of Assrt's Chinese subtitles are styled bilingual ASS, and the styling disappears after export. D6 says "features must be complete", so it's listed below for you to confirm.
- **JustSubtitles actually depends heavily on the TMDB key**: without a key, IDs are matched by title search, and *Inception* already has two results with identical titles (only the year tells them apart); switching to the SubDL fallback mode in turn needs a SubDL key. D5 says it's the most important source, so both keys are effectively almost required.
- **Ownership of `deploy/data`**: folders Docker creates automatically belong to root, and the services can't write to them. This is now noted in `.env.example` and the AGENTS commands. Suggestion (not required by the spec): have the services check at startup that `/data` is writable, and otherwise report an explanatory error.
- **webtorrent security advisory**: unchanged (3.0.21; `ip` 2.0.1 has no fixed version). Phase 9 needs to write a conclusion.
- **ARM**: no ARM machine, not confirmed.

## What Brian needs to decide or provide

### To provide

| Item | Used for | Without it |
| --- | --- | --- |
| A currently working YTS URL | Completing the YTS part of item 4; phase 2 | Develop against the fake YTS and postpone the real part |
| `TMDB_KEY`, `ASSRT_TOKEN`, `SUBDL_KEY` in `deploy/.env` | Completing item 4 | Develop those three sources from the docs and fake data |
| The deployment machine: is it this one? CPU, memory, disk, x86 or ARM | Conclusions for items 5 and 6, phase 9 | Assume it's this one for now |
| Whether the router forwards 51413 (TCP/UDP) and 51414 (UDP) | Incoming connections | Downloads still work, just slower |
| Open the playback test page once in Chrome, Firefox and Safari | Item 7 | Only the Chromium conclusion |

### To decide

1. **Whether to invest in another speech detector** (item 6).
   - Option A (**recommended**): in phase 6, first fix the segmentation and selection logic and change the interface wording, keeping webrtc; films with heavy scores rely on manual anchors. The image doesn't change.
   - Option B: in phase 6, also try whisper transcription or fixing silero, and decide after measuring whether to put it in the image (several GB more, uses CPU).
2. **D34 vs. D6**: is it OK for the first version to drop ASS styling on export?
   - Option A (**recommended**): yes, per the spec; "keep ASS styling" stays as a later item.
   - Option B: keep it in the first version; the workload of phases 6 and 7 would grow noticeably.

### `docs/16-risks.md` "Things for Brian to confirm" (verbatim)

| Item | Current default | Alternative |
| --- | --- | --- |
| Decisions whose source is "Handover": D18, D25, D30 to D41 | See [00-decisions.md](../00-decisions.md) | |
| An administrator needs to work on someone else's film (sync subtitles, pause a download) | First add that version to their own library, then act like any other holder; to stop someone else's download, use force delete. Matches the prototype | Administrators can act on anyone's film directly |
| When the "download finished" notification is sent | The moment the download finishes (subtitles can already be searched for at that point) | Send it after audio analysis finishes (the prototype's approach, about a minute later) |
| A background job fails | Retry once automatically, and show it as failed only if it fails again | No automatic retry |
| Searching by Chinese title | Not done (YTS only knows English titles) | Later, use TMDB to map Chinese titles |
| How Simplified is converted to Traditional | Both characters and terms are changed to Taiwanese usage (软件 → 軟體, "software") | Characters only, not terms |
| Seeding | Stop when the download finishes | Seed to a ratio of 1.0 |
| Upload speed limit | 512 KB/s | |
| Concurrent downloads | 2 site-wide, 2 per person | |
| Members can see other members' names (on shared films) | They can | Anonymized as "someone else" |
| Whether members can delete subtitles added by others | They can (subtitles are shared by the film) | Only the person who added them and administrators can |
| Default preview file resolution | 480p | 720p |
| Punctuation in interface copy | Full-width commas, colons, semicolons and parentheses; see [17-ui.md](../17-ui.md) | Half-width, as in the prototype |

### Items in `docs/agent-notes.md` marked "needs Brian to confirm"

- **On films with heavy scores, webrtc speech detection doesn't pick up the dialogue**: this is item 1 of "To decide" above.

## How to see the results

From scratch (needs Node 24, pnpm 12, Docker):

```bash
pnpm install && pnpm typecheck && pnpm lint && pnpm test
mkdir -p deploy/data
docker compose -f deploy/docker-compose.yml up -d --build
```

Open `http://localhost:8088/` (the local `deploy/.env` changes the port to 8088 because 8080 is used by another project), and you'll see a page saying "拍板" (Paiban); `http://localhost:8088/api/health` returns `{"ok":true}`. You can't sign in yet at this phase. The first administrator's username and password are in `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in `deploy/.env`, and become usable once sign-in is built in phase 1.

Reference tests in the image: `scripts/phase0/reference-in-image.sh`.

Playback test page: the server is still running (`node scripts/phase0/playback/serve.mjs 8090`, listening on all network interfaces; it only serves the test page and the two files, with no sign-in). This machine's address doesn't look like a private range, so if it faces the internet directly, this port is reachable from outside too. Open `http://<this machine's address>:8090/` from your computer or phone, press "Start", and paste me the text in the gray box; please also check by ear whether the 5.1 file has sound. The test files are converted from *Tears of Steel* (CC BY), in `.scratch/playback/`, not committed. Let me know when you're done and I'll shut the server down; to regenerate the files, use `scripts/phase0/playback/make-files.sh`.

`.scratch/` still holds two open movies (about 1 GB), their analysis results and the recorded raw responses, for completing checks and for phase 6; none of it is committed, and the whole folder can be deleted when no longer needed.
