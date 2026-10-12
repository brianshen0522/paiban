# Implementation notes

Questions, contradictions and gaps found while reading the spec and implementing, and how they were judged at the time. Newest at the top.

Format of each entry:

```text
## 2026-10-12 How the preview reservation is counted when the running time is 0

- Where: docs/10-storage.md, docs/05-yts.md
- Problem: ……
- Judgment: …… (basis: D24 in docs/00-decisions.md)
- Needs Brian's confirmation: yes / no
```

## 2026-10-06 Front end of the workspace, sync workbench and system status page: a few judgment calls

- Where: docs/09-sync-workbench.md, docs/11-pages.md, docs/04-api.md
- Problems and judgments:
  1. `exports` from `GET /api/library/:torrentId` was still the empty list left over from phase 4, so the Export tab couldn't show finished files. Changed to call `exportsForTorrent`, which the export module already had (a one-line hookup on the server; added a test that goes through this endpoint).
  2. When `/library/:torrentId/sync` doesn't name a subtitle, it opens "the first unconfirmed one". After confirming, "the first unconfirmed one" becomes a different one, and the workbench would jump to other subtitles. Fix: on opening, replace the URL with `/sync/<that one's id>` (`replace`), and stay on it from then on.
  3. `/library/:torrentId` itself (not listed in the spec) redirects to the Subtitles tab; when a notification's `link.tab` isn't given, it also goes to the Subtitles tab.
  4. Times in the list follow the prototype's `shortTc`: minutes keep counting up (a two-hour film shows `112:10.000`) rather than switching to hours:minutes:seconds, consistent with 17's "minutes:seconds.milliseconds".
  5. "Draft / Confirmed" in the workbench header: based on the status the server last returned, but before saving, if the times or text differ from when it was confirmed, it shows draft first; undoing back to the confirmed state shows confirmed again (the server never changed). This is compatible with both of 09's sentences, "changing a time or text returns it to draft" and "the decision is made on the server".
  6. On a `subtitle` event, saves by the same account in another tab or device also trigger a reload (only `rev` is checked, not who saved), otherwise you'd only find out at the next save when it hits a conflict.
  7. Unknown `AlignResult.method` names are shown as they are; the `heard` sentences (the language heard, how many pairs were made, how many matched, why the language model failed) are newly written; 09 doesn't have them.
  8. The Storage page was missing "Exports I made", which 10 requires; added this time (can be downloaded and deleted). The Overview's "Background tasks" tile links to the System status page, and its description gives the current task's kind and progress.
  9. On the Subtitles tab, "Auto-align and rank all" is disabled while analysis isn't finished or there is no speech data; the two explanatory sentences are new ("The audio is still being analyzed; auto-align and rank works once it's done. Searching and adding aren't affected." "This film has no speech data, so it can't auto-align and rank. You can analyze it again on the Sync tab.").
  10. The media status block (analysis, speech recognition, preview file progress, "Make preview file", "Analyze again") is in the card at the top of the Sync tab, together with the explanation of the preview source. Speech recognition, as the main session asked, is one quiet line of small text.
- Needs Brian's confirmation: no (item 1 is a server fix, explained separately in the report)

Anything that needs Brian's confirmation is listed again in the next phase report.

---

## 2026-10-06 What the end-to-end test of the full flow found

- Where: docs/14-plan.md phase 9 first item, docs/15-testing.md "Offline end-to-end flow", docs/04-api.md `GET /api/library/:torrentId`
- Problems:
  1. The `exports` returned by the workspace endpoint was always an empty array: a placeholder function left from phase 3; phase 7 wrote `exportsForTorrent` and tested it, but never wired it to the route. Fixed (in a separate commit, with a regression test).
  2. The fake subtitle source only answered for *Inception*, so *Charade*, seeded locally, found no subtitles at all, and the full flow couldn't proceed. The fake source now also answers for `tt9000002` (recorded in changes).
  3. The full-flow test works at the API level: the three services run in one Vitest process, share one folder, and periodic calls to `worker.tick()` and `media.reconcile()` stand in for their own loops and NOTIFY. The browser level (Playwright, `pnpm test:e2e`) doesn't exist yet.
  4. When the host is missing tools, the `console.warn` line at the top of a `describe.skipIf` file isn't visible in Vitest's default reporter (it's only printed with `--reporter=verbose`); you only see the "skipped" count. The media, exports-mux and subtitles files are the same. Not changed.
- Judgment: 1 and 2 fixed per the spec; 3 and 4 written down here, to be decided later.
- Needs Brian's confirmation: no

## 2026-10-05 Auto-align's segment mode creates false breakpoints on real films

- Where: docs/08-media-pipeline.md "Auto-align", `autoAlign` (`allowSplit`) and `pickAlignment` in `packages/shared/src/sync-core/core.ts`
- Problem: phase 0 item 6 measured on *Tears of Steel* (12 minutes, 76 lines of official English subtitles): ffsubsync's single offset was within 0.034 seconds in all four scenarios, "as is, 2.4 seconds late, 23.7 seconds late, different frame rate"; but when the sync core allows segments, every time it splits the last 17 lines into a separate segment moved 38 seconds earlier (where there happens to be other speech), and the score comes out higher (0.717 vs 0.672), so `pickAlignment` picks it every time, so **22% of the lines in the final result are 38 seconds off**, and `agree` is false. With segments turned off, the two methods agree and the offset is 0.03 seconds. In the "different cut (12 seconds missing in the middle)" scenario, neither method recovered it.
- Judgment: don't change the algorithm in phase 0 (it belongs to phase 6). Phase 6 must handle: the segment penalty (currently 3 seconds of dialogue) is too small on real films; how many lines a segment needs at minimum and how much better than a single offset it must be to count; how to choose when the two methods disagree. The report lists the measurements and recommendations.
- Needs Brian's confirmation: no (a phase 6 tuning; the D33 approach doesn't change). But the results go at the very top of the report.

## 2026-10-05 On films with heavy scores, webrtc speech detection misses the dialogue

- Where: docs/08-media-pipeline.md "3. Speech detection", docs/16-risks.md item 1
- Problem: on *Sintel* (15 minutes, 26 lines, heavy score, light dialogue), the detected "speech" is only 14%, and mostly not dialogue: the correct subtitles score only 20% (25 of 26 lines below 50%). In all five scenarios both methods got it wrong (median error 12 to 79 seconds). *Tears of Steel* is fine (correct subtitles 67%, speech 48%). Tried ffsubsync's `--vad silero`: it needs torch installed separately (a 5.3 GB environment), it runs to completion, but the whole output is 0; ffsubsync 0.5.1 is incompatible with the current silero-vad model, and no meaningful result came out.
- Judgment: the product still holds up (the manual tools don't depend on detection, as 16-risks item 1 already anticipates). But "auto-align" gives wrong results on films like this, with a low score and `agree` false: the interface must say plainly in this case that "auto-align is unreliable, use anchors". Switching detection methods (silero needs the compatibility fixed, or whisper) is a trade-off for Brian to decide (image size, CPU).
- Needs Brian's confirmation: yes (whether to invest in another speech detection method in phase 6; see the report)

## 2026-10-05 Score thresholds are too high on real films

- Where: docs/08-media-pipeline.md "Sync score", docs/16-risks.md item 14
- Problem: the correct official subtitles score 67% overall on *Tears of Steel* (the thresholds are 70% green, 55% yellow); of 76 lines, 22 are below 50% and 5 below 25% (the per-line thresholds are 50% and 25%). That is, correctly synced subtitles show yellow, and three in ten lines are yellow or red.
- Judgment: the thresholds are shared constants to begin with. Phase 6 will set them with more real material; for now just record the numbers.
- Needs Brian's confirmation: no

## 2026-10-05 Passive incoming-connection checks are fooled by UDP hole punching

- Where: docs/06-torrent-worker.md "Incoming connections", D32
- Problem: phase 0 item 5, on a Docker bridge network with the ports only published in compose and no certainty whether the router forwards them, observed 1 `utpIncoming` during the download. uTP runs over UDP; after we connect out first, NAT briefly lets the other side connect back on the same port, so one `utpIncoming` doesn't prove the port is forwarded. There was not a single `tcpIncoming`.
- Judgment: recommend using only `tcpIncoming` to decide "the port is open", with `utpIncoming` recorded but not trusted. This is a detail of D32, whose source is "Handover", so it can be adopted directly; recorded here first, and in phase 3 the implementation will change 06 and record it in changes.
- Needs Brian's confirmation: no. But I'd like to know: does the router forward 51413 (TCP/UDP) and 51414 (UDP)?

## 2026-10-05 Port 8080 on this machine is already used by another project

- Where: deploy/.env, `HTTP_PORT=8080` in `.env.example`
- Problem: another project on this machine (forward) occupies 8080.
- Judgment: change only the local `deploy/.env`: `HTTP_PORT=8088`, `HTTPS_PORT=8448`, `PUBLIC_URL=http://localhost:8088`. The defaults in `.env.example` stay as they are.
- Needs Brian's confirmation: no

## 2026-10-05 Playwright's bundled Chromium can actually decode H.264

- Where: docs/15-testing.md "Notes on browser tests", docs/08-media-pipeline.md, fixtures/README.md
- Problem: the docs say the bundled Chromium can't decode H.264, so the end-to-end tests use WebM. In practice, Playwright 1.63's Chromium (HeadlessChrome 153) plays H.264 High + AAC (including 5.1) MP4 and can seek, and the picture really is decoded (`getVideoPlaybackQuality` reports frames, and the picture isn't black).
- Judgment: correct the docs to match reality. The WebM path (counting WebM as directly playable, end-to-end tests using `clip.webm`) doesn't need removing: it doesn't depend on this, and this may change again when Playwright changes versions. Recorded in changes.
- Needs Brian's confirmation: no

## 2026-10-05 bsdtar sets no limits for us when extracting

- Where: docs/07-subtitle-providers.md "Download and processing (`subtitle.resolve` downloads; `subtitle.fetch` / `subtitle.ingest` process)" step 3, docs/12-auth.md "Uploads and archives"
- Problem: bsdtar 3.7.4 in the image can extract zip, 7z and RAR5. With malicious archives: entries containing `..` are rejected (exit code 1, but the other entries are still extracted), a leading `/` is stripped automatically, **symbolic links are extracted as is**, and the number of entries and the extracted size are **not limited at all** (a 60 MB bomb is extracted in full).
- Judgment: phase 5 does its own checks per the spec: first list the entries with `bsdtar -tvf`, and reject the whole archive if there are symbolic links, absolute paths, `..`, more than 200 entries, or a declared size over the limit; while extracting, check again using the bytes actually written (the sizes in the headers can be faked). The spec says zip uses "a Node library"; using bsdtar for all three formats is simpler; phase 5 decides and records it in changes. Malicious-archive test fixtures are already made and in `fixtures/archives/`.
- Needs Brian's confirmation: no

## 2026-10-05 JustSubtitles' `ZH` category holds Traditional Chinese subtitles

- Where: docs/07-subtitle-providers.md "Languages"
- Problem: the first file phase 0 downloaded from JustSubtitles' `ZH` (nominally Simplified) was a `.hk.srt` with Traditional Chinese subtitles (UTF-8, no BOM); YIFY's `Chinese` is also Traditional (UTF-8 with BOM).
- Judgment: consistent with the docs' "the language a source labels is only a hint; check it again from the content", no change needed. The detection function in `reference/subtitles` correctly classifies both as `zh-Hant`.
- Needs Brian's confirmation: no

## 2026-10-05 Contradictions and gaps found while reading the spec (from phase 1 on)

The cross-check of `docs/03`, `04`, `09`, `11`, `13`, `17` against `packages/shared/src/contracts/api.ts` and `db/schema.sql` was done by an auxiliary review process; I spot-checked three of them (items 1, 2 and 4), and all were accurate. The rest will be confirmed one by one when work reaches that phase, and the docs and contract changed then. Following the order in AGENTS.md, all of these are mine to judge and don't need Brian's decision; they are listed here so they aren't missed when work gets there.

Ones that make the spec impossible to implement literally:

1. `media_files.error` has only one slot (`db/schema.sql` line 233, `MediaStatus.error`), so errors from different assets overwrite each other: `NO_AUDIO` is recorded first, then a failed preview video overwrites it, and the workbench can't say "why there is no waveform". Recommend recording per asset. Phase 4.
2. Broadcast events contain fields that differ per recipient: `{type:'torrent', torrent: Torrent}` goes to all holders, but `Torrent.mine` is computed per caller; `Export.canDelete` likewise. Recommend that `api` serialize separately for each SSE connection. Phase 1/3.
3. The responses to pause, resume and download don't tell whether it "starts right away or has to queue", yet 11 picks the notice text based on that; "back to the end of the queue" doesn't say who updates `queued_at` (03 says `api` only writes `want`). Phase 3.
4. `ProviderStatus.error.code` has no `INVALID_KEY`: Assrt's `20001` is recorded as `NOT_CONFIGURED` when searching but is `INVALID_KEY` when testing, so the screen would say "token not set yet" when the token is actually invalid; when JustSubtitles' subdl mode is missing its key, the screen would say the TMDB key is missing. Phase 5.

Ones that affect correctness (summary): notification link kinds aren't enough (`item.deleted` should go to Library, export notifications to the Storage page, but `link.page` has only two kinds); searching again replaces not-yet-fetched candidates in other languages too; pressing "Make preview file" on a film with no audio track makes an audio file for nothing; the workbench lacks the state "no playable source, and nothing in progress"; the Overview page's "Download failed" links to a page whose default view doesn't show other people's downloads; when an administrator views all downloads site-wide, no event triggers an update; `DISK_LOW` has no threshold; the error codes and units for changing the storage limit aren't specified; `LAST_ADMIN` only happens when two administrators demote each other at the same time, and needs a lock; `ACCOUNT_DISABLED` must only be returned after the password is correct; the list of exceptions to "GET doesn't change data" misses session extension and `users.last_seen_at`; several validation errors when creating an export have no error code; 12's checklist conflicts with 04 (a creator can still download their own export after leaving the film's library); "exported MKVs are not affected" doesn't hold for exports that haven't finished; the default export file name always says `zh-TW`.

Minor: `MovieSummary.mine` counts failed downloads as "Downloading"; `MediaStatus` has no video codec field, but the header needs to show it; in 12's activity log table, the "same as above" for `subtitle.confirm` points at the wrong row; who sets `analysis_state` from `analyzeAuto` when a download finishes isn't in 03's transaction table; whether `doc_rev` goes up by 1 on confirm, and whether events triggered by one's own save should be ignored; how to override the number of checkpoints in tests; `NO_AUDIO` would hang in "Needs attention" forever; nothing ever sets `data-theme`; the meaning of `freeBytes` in `DISK_FULL` isn't defined.

- Needs Brian's confirmation: no
