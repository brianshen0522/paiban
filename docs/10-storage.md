# 10 Storage rules

Brian's own words (D7): no scheduled deletion; an administrator can set a storage limit in the system; once the limit is reached, no new films can be loaded; files must be deleted by hand before downloading again. Whether exports count, he left to me; I decided they "count" (D8).

This document turns those sentences into precise rules. The database side is `storage_usage` and `storage_admit` in `db/schema.sql`, with tests (`db/schema.test.mjs`).

## Five rules

1. **The system never deletes any file automatically.** No schedules, no retention periods, no "clear the oldest when space runs out". Every deletion is something a person pressed.
2. **One limit for the whole site**, set by an administrator. No per-user quotas.
3. **Nothing that would push usage over the limit can start.** That covers: downloading a new film, retrying a failed download, exporting an MKV, and requesting a preview file afterwards.
4. **Take it all up front.** The moment a download is admitted, its full size (plus the preview reservation) counts toward usage. "Halfway through the download it turns out not to fit" never happens.
5. **A shared film counts once.** One version has only one copy of its files no matter how many people hold it; it's deleted only when everyone has removed it.

## How usage is counted

Usage is the sum of five categories. The color bar and legend in the interface are exactly these five (colors in [17-ui.md](17-ui.md)).

| Category | Name in the interface | What it includes |
| --- | --- | --- |
| `movies` | Videos | The actual on-disk size of finished downloads, plus their subtitles, candidate subtitles and analysis data. Posters don't count |
| `previews` | Preview files | The actual size of preview videos and audio files; for ones still being made, their reserved amount |
| `reserved` | Reserved for downloads | Unfinished downloads (queued, downloading, paused): full size plus the preview reservation |
| `partial` | Left over from failed downloads | The actual size failed downloads left on disk |
| `exports` | Exported MKVs | Finished: actual size; in progress: the reserved amount |

```
used      = movies + previews + reserved + partial + exports
remaining = max(0, limit − used)
over      = used > limit
```

GB in the interface means 1024³ bytes, matching the sizes YTS shows. The API always sends bytes.

## Admission and refusal (admission)

Every action that increases usage first asks `storage_admit(need, freed)` inside a database transaction, and writes only if it passes. The function takes a lock, so concurrent requests are judged one at a time.

| Action | Need | Freed at the same time |
| --- | --- | --- |
| Download a new version | Film size + preview reservation | |
| Add a torrent by hand | Size of the largest video file + preview reservation (`.mp4` / `.m4v` files whose names don't look like x264, 8-bit all get a preview reservation up front) | The torrent's other files aren't downloaded and don't count |
| Retry a failed download | Film size (the larger of what YTS lists and the torrent's actual size) + preview reservation | Its leftover size |
| Torrent info turns out larger than YTS listed | The difference. Within 64 MB, no check; just record the actual size | |
| Turns out not to play directly after downloading | Preview reservation (by the settings at that time) | |
| Runtime longer than estimated, reservation must grow | The difference. If it doesn't pass, give up on the preview video and keep only the audio file | |
| Preview file requested afterwards (the workbench's "Make preview file", or an administrator retrying a failed preview job) | Reservation for the missing assets | |
| Export an MKV | Video file size × 1.01 + 1 MB | |

The test: `used − freed + need ≤ limit`. **Exactly equal to the limit is allowed.**

Failed jobs (preview assets, exports) are retried once automatically; that retry keeps the original reservation without a new admission. The reservation is released only when it finally fails for good.

No admission needed for: adding a version someone else has already downloaded, pausing, resuming, adding subtitles (subtitles are small and count after being added; see "Small files" below).

On refusal, return `STORAGE_LIMIT` with the need, remaining, shortfall, and how much of it is preview reservation. The interface must use these four numbers to write a complete sentence, for example:

> Not enough space. This version is 5.9 GB, plus about 600 MB for the preview file; 5.6 GB is left, so 900 MB more is needed. Delete films or exports you don't need first, then come back to download.

### Space on the disk itself

The limit is a logical number. The disk may be shared with other things, so every admission also checks physical space:

```
available     = free space currently on the filesystem holding /data
not yet written = the amount each unfinished download (queued, downloading, paused) hasn't fetched yet
                + preview reservations not yet done (on download rows and on media rows)
                + reservations of queued and running exports
newly written = need − the amount already on disk that this action will reuse
passes if     : available − not yet written ≥ newly written + system reserve (STORAGE_RESERVE_GB, default 2 GB)
```

"The amount not fetched yet" is `max(size_bytes, length_bytes) − downloaded_bytes`. Paused and queued downloads count too: sooner or later they'll fill that space. "The amount this action will reuse" is non-zero only for a retry: the failed download's leftovers already occupy the disk, and a retry continues writing rather than taking the space again from scratch.

If it doesn't pass, return `DISK_FULL`. That's a different thing from being over the limit: the interface must say "the disk itself is full; ask an administrator to deal with it".

## Preview reservation

Versions the browser can't play directly need preview assets (an audio file and a preview video, see [08-media-pipeline.md](08-media-pipeline.md)). Their size isn't known before downloading, so the reservation uses **the transcoding bitrate caps**, guaranteeing it won't be exceeded:

| Asset | Reserved per second of runtime | Basis |
| --- | --- | --- |
| Audio file | 16,320 bytes | 128 kbps × 1.02 |
| Preview video 480p | 88,740 bytes | (600 + 96) kbps × 1.02 |
| Preview video 720p | 203,490 bytes | (1500 + 96) kbps × 1.02 |

1.02 is the container overhead.

```
preview reservation(runtime seconds) =
  plays directly                          → 0
  doesn't play directly, auto-convert on  → (audio file + preview video at the chosen resolution) × runtime
  doesn't play directly, auto-convert off → audio file × runtime
```

Runtime uses YTS's `runtime` (minutes); when it's 0, use 120 minutes. Recompute once the actual runtime is probed (for what happens when it grows and no longer fits, see [08-media-pipeline.md](08-media-pipeline.md), "1. Probe").

**This plan is fixed the moment the download is admitted** (D40): how much to reserve, whether to make a preview video, and at what resolution are all recorded on that download (`preview_reserve_bytes`, `preview_proxy_res`) and carried over unchanged to the media row when the download finishes. If an administrator later changes "auto-convert preview files" or the resolution, it only affects downloads admitted after that. That way the reserved space and what will actually be done always match: "reserved for 480p, but on completion converted to 720p under the new setting" never happens.

| Example | Reserved | Usually actual |
| --- | --- | --- |
| 96 minutes, 480p | 0.56 GB | about 0.3 GB |
| 120 minutes, 480p | 0.70 GB | about 0.4 GB |
| 120 minutes, 720p | 1.47 GB | about 0.7 GB |
| 120 minutes, auto-convert off (audio file only) | 0.11 GB | about 0.08 GB |

When an asset finishes, its actual size is recorded instead and the excess is released automatically; on failure the whole reservation is released.

The prototype shows smaller numbers ("480p, about 340 MB per 2 hours"); those are typical sizes. The real interface must say both: the settings page gives the typical size and notes "Some extra space is reserved before downloading and released once the file is made"; when blocked on the film page, use the reserved number. The settings page options follow the prototype ("480p (about 340 MB per 2 hours)", "720p (about 800 MB per 2 hours)", with a line below: "Preview files are only for syncing subtitles and count toward the storage limit."), plus a sentence explaining the reservation.

Another difference from the prototype: with auto-convert off, the prototype reserves nothing at all; the real version still reserves the audio file's amount, because the audio file is made regardless (audio-only mode needs it).

## Lowering the limit

An administrator can set the limit below current usage (D22). Then:

- **Nothing is deleted.**
- Everyone's downloads and exports are blocked until usage falls below the limit.
- Downloads in progress continue (they were counted long ago).
- The usage indicator at the top of every page turns red; the Storage page shows: "Over the storage limit. Nobody can download or export until usage is back under the limit. No files are deleted automatically."

### Validating the limit

The interface takes a whole number in GB.

| Input | Result | Explanation in the interface |
| --- | --- | --- |
| Not a whole number of 1 or more | Rejected | The limit must be a whole number of 1 or more (GB). |
| More than the disk can give | Rejected | More than the disk can provide. The limit can be at most 30 GB. |
| Not changed yet | | The disk has 32 GB in total, with 2 GB kept for the system; the limit can be set up to 30 GB. |
| Below current usage | **Allowed**; the button becomes "Save anyway" | Below the current usage of 22.3 GB. Saving won't delete any files, but nobody can download or export until usage drops below 12 GB. |
| Anything else | Allowed | After saving, 3.7 GB more will fit. |

The most the disk can give:

```
max limit = (used − not yet written) + available − system reserve
```

That is, "what this site already has on the disk" plus "what's still free on the disk", minus the reserve. If the disk is dedicated to this site, it's roughly the disk size minus the reserve.

The "not changed yet" sentence differs slightly from the prototype: the prototype says "…, so the limit can be at most 30 GB", which assumes the whole disk belongs to this site. When the disk is shared with other things, the max limit isn't the disk size minus the reserve, so the real version doesn't say "so". The three numbers come from `DiskInfo` (`totalBytes`, `reserveBytes`, `maxLimitBytes`).

Message after saving: "The limit is now 26 GB."; if usage is over the limit after the change, append "Currently over the limit; downloads and exports will be blocked."; pressing save without changing the number gives "The limit didn't change."

The `STORAGE_LIMIT_GB` environment variable is written only once, on first startup, when the settings table has no limit yet. **With no limit set, nothing can start** (`storage_admit` returns not passed).

## Deletion

Every deletion is started by a person. Before the button is pressed, the interface must say clearly what will happen and how much is freed. The prototype has all the copy; use it.

| Who | Action | Result |
| --- | --- | --- |
| Holder | Remove from Library while others still hold it | It's just no longer in their library. The files stay put and **no space is freed**. The confirmation must say so |
| Holder | Delete the whole film from Library (they're the last one) | The video, preview files, this film's subtitles and sync results, and **all of this film's exports** are deleted (Brian, 2026-10-06). For exports made by others, their creators get a notification |
| Holder | Cancel a running or queued download | Same logic as above: if others still hold it, just leave; otherwise stop and delete what was downloaded |
| Holder | Remove a failed download | Delete the leftovers |
| Creator or administrator | Delete an export | Delete that MKV |
| Holder | Remove subtitles | Delete the subtitles and their sync. Very small, not worth mentioning space |
| Holder | Remove a candidate | Delete that candidate and the files fetched for it (mainly to clear failed uploads). No confirmation dialog |
| Administrator | Force delete any item | Regardless of who holds it. Deleting a film also deletes all of its exports. Affected people get a notification (`item.deleted`): for films, reservations, leftovers and preview files, every holder is notified; for exports, the creator; the administrator who pressed delete is not notified. This notification is new in the real version; the prototype doesn't have it |
| Administrator | Delete a preview file | The preview video and audio file are deleted together, and one being converted is stopped. **It isn't reconverted automatically**: the next person who wants to sync this film presses "Make preview file" in the workbench |
| Administrator | Delete an orphan folder | A folder found while recounting usage that has no record in the database. Delete that folder |
| Administrator | Remove an account | **None of their files are deleted.** Items they held alone end up with no holder and stay on the Storage management page for an administrator to decide |

### Confirmation wording

Every kind of deletion has an explanation before it's pressed. The two on the Library page (the most important) are in [11-pages.md](11-pages.md); the rest are here, written as in the prototype, with the numbers replaced by real ones.

"What I hold" on the Storage page (everyone):

| Situation | Text | Button |
| --- | --- | --- |
| Not finished downloading | Cancel and delete what was downloaded? | Cancel download |
| Finished, others still hold it | Remove from your library? Meiling still holds it, so no space will be freed. | Remove |
| Finished, you're the last one | Deleting frees 2.3 GB; the subtitles and 1 exported MKV are deleted too. (Not mentioned when there are no exports; the size includes the exports) | Remove |
| Leftovers from a failed download | Remove this entry and delete the 300 MB left over? | Remove |
| An export you made | Deleting frees 1.9 GB. | Delete |

The button that opens the confirmation dialog reads, depending on the situation: "Cancel download" (not finished downloading), "Remove from Library" (others still hold it), "Delete" (you're the last one; exports), "Remove" (failed leftovers). For failed leftovers the prototype used "Cancel and delete what was downloaded?", inconsistent with the Downloads page; the real version uses the Downloads page's sentence throughout.

Each row on this page: kind, name (films are followed by "plus a 430 MB preview file"), size, holders ("Only you" when it's just you), action. Export rows also have "Download" (the prototype's version of this page has no download button). Deleting a whole film deletes its exports too; download them first to keep them.

Two other confirmations are on other pages: removing subtitles on the Subtitles tab is "Remove these subtitles and their sync?"; deleting an export on the Export tab is "Delete this export and free 1.9 GB?".

Force delete on the Storage management page (administrators):

| Item | Text |
| --- | --- |
| Film, held by someone | Removes it from 2 holders' libraries and deletes it along with its subtitles, preview file and 1 exported MKV, freeing 4.2 GB. |
| Film, held by nobody | Nobody holds it right now. Deletes it along with its subtitles, preview file and 1 exported MKV, freeing 4.2 GB. |
| Reserved for downloads | Cancels Meiling's download and deletes what was downloaded. |
| Leftovers from a failed download | Deletes the 300 MB left over. |
| Preview file | Deletes the preview file. Whoever syncs this film next has to press "Make preview file" in the workbench again. |
| Exported MKV | Deletes Meiling's export, freeing 1.9 GB. |
| Orphan folder | This folder has no record in the database. Deleting it frees 1.2 GB. |

The preview file sentence differs from the prototype (the prototype says "it will be converted again"; the real version doesn't reconvert automatically); the orphan folder sentence is new. For films without a preview file, drop "preview file" from the sentence.

### Which clean-ups don't count as "automatic deletion"

Rule 1 protects things users put in or made: films, preview files, subtitles, sync results, exports, and leftovers from failed downloads. The things below are the program's own scratch work, outside that protection, and **only these** may be removed by the program on its own:

| Thing | When it's removed |
| --- | --- |
| Upload temp files and working directories in `/data/tmp/` | When the job using it ends; when `media` starts, it also clears upload or download temp files no candidate is waiting on anymore (that candidate was removed, processed, or stuck for over 10 minutes and marked failed) |
| `*.part` (half-written preview files, audio files, exports) | When that job fails or is cancelled; when `media` starts, it clears ones left over from last time under `/data/media` and `/data/exports`. **It doesn't look under `/data/torrents`**: that's downloaded content, and even a file named `.part` there isn't ours |
| Subtitle track files staged for export (`tracks/`) | When packing reaches a final result (done, failed twice, cancelled, the source film removed). Deleted by the packing job; when the film is removed, `torrent` also deletes them for the exports it marks failed ([03-data-model.md](03-data-model.md)); if `api` wrote the track files while creating an export but the row wasn't written, it also deletes what it just wrote |
| What a job (or `api`'s "add subtitles") just wrote, when its final conditional write didn't succeed: the film was removed partway, the preview asset was deleted by an administrator, the candidate was removed, the export was cancelled | It deletes the files it just wrote, and any folder it created that is now empty. This is part of that deletion or cancellation, not a separate one; without it, folders with no record would appear after a deletion ([03-data-model.md](03-data-model.md)) |
| The queue system's own job records | Managed by pg-boss |
| The outbound lookup cache (`provider_cache`), recount findings (`storage_findings`) | Table rows, not files. The cache is overwritten on the next lookup; findings are replaced wholesale on the next recount |

**To make this rule hold, only one module in the code may delete things under `/data`** (e.g. `apps/server/src/storage/remove.ts`). Each of its functions corresponds to one case in the "Deletion" table (who, action, result) or in the scratch clean-up table above, and each must leave a record: user-initiated ones go into `audit_log`, scratch clean-ups into the log. Nothing else calls `rm`, `unlink` or `rmdir` directly; WebTorrent's `client.remove(…, { destroyStore: true })` also counts as deletion and may likewise only be called from this module.

Add a test that scans the source code for this. It must confirm two things:

- Calls that delete files appear only in this module.
- **No deletion is decided by "time is up" or "it's old".** The code naturally has loops that run on a timer (`torrent` checks every 2 seconds for rows with `want = 'remove'`); that doesn't count, because what it executes is a deletion someone has already pressed. What's being blocked is the "compare timestamps, delete after so long" kind of decision: the deletion module's functions neither accept nor compute any "how long ago" condition.

## Small files

Subtitles, candidate subtitles, waveforms and speech data are all small (a few MB per film in total). They're counted in `movies` as they are, but **no admission is done when adding them**: blocking "add subtitles" over a few hundred KB makes no sense. Usage may therefore go slightly over the limit (by MBs), which is acceptable; later downloads and exports are still blocked.

Posters are even smaller and are deleted along with the film, so they don't count toward usage, and the database doesn't store their size. Temp files under `/data/tmp` don't count either.

Candidate subtitle files are fetched only when the user presses "Rank" or "Add". Searching again doesn't delete candidates already fetched; they're deleted with the film, or removed one by one by a holder.

## Recounting usage

The numbers in the database were measured at various points in time. An administrator's "Recount usage" actually walks the disk. On a big disk this takes a while, so it's a background task (`storage.rescan`): the button returns immediately, the page shows "Recounting…", and it updates when the completion event arrives.

1. Each finished or failed download: measure the folder size and update `disk_bytes` if it differs. Downloads still in progress aren't measured (they count the reservation, not the actual size).
2. Preview assets, analysis data, subtitles, candidates, exports: handled the same way.
3. Find **orphans**: folders under the five places below with no matching record in the database.

   | Location (`root`) | Folder name maps to |
   | --- | --- |
   | `/data/torrents`(`torrents`) | `torrents.info_hash` |
   | `/data/media`(`media`) | `media_files.id` |
   | `/data/subtitles` (`subtitles`) | `subtitles.id`. The `candidates` folder at this level is skipped; it's the next row |
   | `/data/subtitles/candidates`(`candidates`) | `subtitle_candidates.id` |
   | `/data/exports`(`exports`) | `exports.id` |

4. Find **missing**: records in the database whose files are gone (a finished download without its main video file, a finished export without its MKV, subtitles without `cues.json`).
5. Write the results of steps 3 and 4 into `storage_findings` (clear the previous run's first, then write this run's), then `NOTIFY` (`storage`).

**This job only updates numbers and reports; it deletes nothing.**

Orphans and missing items appear in the "Found while recounting" section of the Storage management page, and under "Needs attention" on the Overview page. Whether to delete an orphan is up to an administrator (`DELETE /api/admin/storage/items/orphan/<id of that finding>`; the path is built from that record's `root` and `name`, not taken from the request); before deleting, confirm once more that it still has no matching record. Missing items are view-only; to deal with one, remove that item.

**Orphans don't count toward usage**: usage only counts things the database has records for. But they really do take up disk space and make the "Space on the disk itself" check block sooner, so administrators need to be able to see them. Normal operation shouldn't produce orphans; when they appear, it's usually because the program was killed in the middle of a deletion, or someone touched `/data` by hand.

## How it appears in the interface

| Where | What |
| --- | --- |
| Top of every page | Usage indicator: a thin progress bar plus "22.3 GB / 26 GB". Yellow when under 2 GB is left; red when under 0.5 GB is left or over the limit. Clicking it goes to the Storage page |
| Film page | "Storage: 20.5 GB used, limit 26 GB, 5.6 GB more fits." plus the color bar. When download is pressed on a version that doesn't fit, an explanation expands below that row |
| Export tab | "The export is about 1.9 GB, the same size as the original. 3.7 GB is left now; 1.8 GB will be left after exporting." The number uses `Workspace.exportNeedBytes` (about 1% more than the original, the amount actually used for the space check). When it doesn't fit, this becomes a red explanation and "Start export" is disabled |
| Storage page (everyone) | Big number, color bar, legend, the four rules, What I hold (`GET /api/storage`) and Exports I made (`GET /api/exports`; can be downloaded and deleted). Items can be removed from here. When over the limit, there's a red explanation at the top (wording in "Lowering the limit"); when under 2 GB is left, a yellow one: "Space is almost full. Only 1.6 GB is left, so larger versions no longer fit." |
| Storage management page (administrators) | The same usage, the limit form, all items from largest to smallest, force delete, recount, and the orphans and missing items found while recounting |
| Overview page (administrators) | Shows up under "Needs attention" when over the limit or when under 2 GB is left |

The four rules on the Storage page (as in the prototype):

- The system never deletes files on its own. Space is freed only when someone deletes something.
- A download can't start if it would go over the limit; exporting an MKV needs space too.
- A download reserves its full size from the start, so it never runs out of space halfway.
- A film shared by several people takes space once, and is only deleted when everyone removes it.

When usage changes, a `usage` event goes to everyone, and the indicator at the top updates live.

## Cases to test

`db/schema.test.mjs` already covers the database side. The application level needs at least the cases below. They fall into three phases, because preview files and exports don't exist until later phases ([14-plan.md](14-plan.md)).

Phase 3 (downloads):

- With 5 GB left, two 3 GB downloads submitted at the same time: exactly one succeeds.
- Need exactly equal to remaining: succeeds. One byte more: fails, and the shortfall in the error is 1.
- Adding a version someone else already has: usage unchanged, succeeds no matter how much is left.
- Retrying a failed download: the need minus the leftovers.
- Lowering the limit below usage: succeeds; downloads afterwards return `STORAGE_LIMIT`; the number of files on disk is unchanged.
- The last holder removes it: the folder disappears and usage drops.
- Not the last one: the folder stays and usage is unchanged.
- Someone joins while the last holder is removing: either the join succeeds and the files stay, or the joiner gets `TORRENT_STATE`; "join succeeded but the files were deleted" never happens.
- Removing an account: all their files are still there, shown on the admin page with no holders.
- A version that doesn't play directly: usage includes the preview reservation when the download is admitted; after changing the preview settings, this download's reservation and plan are unchanged.
- Torrent more than 64 MB larger than YTS listed and not enough space: the download fails, what was downloaded stays, and usage counts the leftovers.
- No limit set: nothing can start.
- Not enough free space on the disk itself (limit not yet reached): returns `DISK_FULL`.
- Source scan: nothing outside the designated module deletes files under `/data`; no deletion is decided by time or age (see "Which clean-ups don't count as "automatic deletion"").

Phase 4 (preview files):

- After a preview file finishes, usage changes from the reserved value to the actual value.
- Preview file fails (fails twice): the reservation is released; after the first failure the reservation is still there.
- An administrator deletes a half-converted preview file: ffmpeg stops, no files are left, and the reservation goes to zero.
- Requesting a preview file afterwards without enough space: returns `STORAGE_LIMIT`, state unchanged.
- Recounting usage: put an extra folder in by hand and delete a file by hand; both show up in the findings list; nothing on disk is deleted.

Phase 7 (exports):

- Can't export when space is short; also can't after lowering the limit below usage.
- The last holder removes the film: the exports are still there and can still be downloaded.
- Export fails (fails twice): the reservation is released; no `.part` or `tracks/` is left behind.
