# 06 Downloader (torrent)

`torrent` is a standalone Node program running a WebTorrent client. It offers no HTTP interface and does not touch the job queue; it reads the "wanted state" in the database, brings the actual state up to it, and writes progress back to the database.

## WebTorrent behavior we have tested

`reference/torrent/local-swarm-test.mjs` is a test that needs no network: one client seeds a file locally, and another downloads it back using only the info hash. It passes on both Node 22.22 and 24.21, and confirms every item below. **Run it once in the target image before implementing.**

| Behavior | Result |
| --- | --- |
| Version | `webtorrent` 3.0.21, pure ESM, requires Node 22 or later. Native modules (uTP, WebRTC) load successfully on both Node versions |
| Adding with only the info hash | Works. The torrent info (file names, sizes, pieces) comes from peers, and `metadata` fires when it arrives |
| `torrent.addPeer()` | **Must not be called before the `infoHash` event**, otherwise it throws |
| Rate limits | `downloadLimit` / `uploadLimit` (bytes/second, -1 means unlimited) are given when creating the client; change them while running with `client.throttleDownload(rate)` / `client.throttleUpload(rate)` |
| `torrent.pause()` | **Does not really pause**: it only stops connecting to new peers, and existing connections keep downloading (the official docs say so too) |
| A real pause | Record `torrent.bitfield.buffer` → `torrent.destroy({ destroyStore: false })`. The files stay on disk |
| Resuming a download | In a new client, use `client.add(hash, { path, bitfield })`. A file of 768 pieces is `ready` in 60 milliseconds, and pieces already present are not fetched again; WebTorrent spot-checks one piece of each file and re-verifies the whole thing only if it is wrong |
| Re-adding a completed one | `client.add(hash, { path, skipVerify: true })` is `ready` immediately with `done` true (used for seeding) |
| Deleting files | `client.remove(hash, { destroyStore: true })` deletes the files |
| Disk allocation | **Does not preallocate the full size**. At 35% downloaded, the file was only 8.9 MB (24 MB total). So "holding space" is a number in the database, not an empty file on disk |

## Client settings

```js
new WebTorrent({
  torrentPort: TORRENT_PORT,        // TCP and uTP (UDP)
  dhtPort: TORRENT_DHT_PORT,        // DHT (UDP)
  natUpnp: false, natPmp: false,    // meaningless in a container; ports are opened by compose and the router
  lsd: false,                       // local service discovery, useless on a bridge network
  downloadLimit, uploadLimit,       // from the settings, 0 becomes -1
  maxConns: 55,                     // connection limit per download, WebTorrent's default
})
```

`client.on('error')` is a fatal error (for example the port is in use): log it and exit the program, letting Docker restart it.

## Main loop: bring the actual state up to the wanted state

Runs every 2 seconds, and immediately on receiving `NOTIFY paiban_torrent`. Each round:

1. Read the settings and apply rate limits if they changed. This goes first: when it was last, downloads that this round had just scheduled ran with no limit at all until it was applied, and a small file could finish downloading at once (found on 2026-10-06 from a flaky test).
2. Read all rows with `want = 'remove'` → perform "Removal".
3. Read rows with `want = 'pause'` whose `state` is `queued` or `downloading` → perform "Pausing".
4. Read rows with `want = 'run'` and `state = 'paused'` → set `state` to `queued` and `queued_at` to now (back to the end of the queue).
5. Scheduling: see the next section.
6. For each active download: write progress and check for stalls.

Every database update in each step is conditional (`where id = $1 and state = '…' and want = '…'`). Affecting 0 rows means the situation changed during this round; handle it next round. The whole loop must be re-entrant: if the program crashes halfway through any step, starting over from the database state after a restart must be correct.

## Scheduling

Two settings: `downloads.maxActive` (how many films download at once site-wide, 1 to 5) and `downloads.maxPerUser` (how many at once per person, no more than the former).

```
active     = number with state = 'downloading'
candidates = state = 'queued' and want = 'run', ordered by queued_at from oldest to newest
for each candidate:
  active >= maxActive                                   → stop
  requester (requested_by) already has maxPerUser active → skip, look at the next one
  otherwise                                             → start the download, active + 1
```

Seeding (completed) downloads don't take a slot.

If the requester's account no longer exists (`requested_by` is empty), or they are no longer a holder of this download: the download is limited only by the site-wide limit and doesn't count toward anyone's per-person limit.

The "position in the queue" is the position in the candidate list, computed by `api` for the front end.

## Starting a download

1. Set `state` to `downloading`, `phase = 'metadata'`, `started_at` and `last_progress_at` to now, and `clean_stop = false`.
2. Confirm the disk really has space: free space on `/data` must exceed "the amount not yet downloaded + the system reserve". If not, mark it failed (`DISK_FULL`).
3. `client.add(magnet link, { path: '/data/torrents/<hash>', bitfield? })`. How the magnet link is built is in [05-yts.md](05-yts.md). `bitfield` is given only if this row has one stored and `clean_stop` was true last time.
4. Attach the events (see the table below).

### On getting the torrent info (`metadata`)

- **Path check**: every file path, once resolved, must fall inside `/data/torrents/<hash>/`. If any one ends up outside, stop this download immediately, mark it failed (`UNSAFE_PATH`), and write a security log entry. No data has been written at this point.
- **Size check**: compare `torrent.length` with the size currently counted, `max(size_bytes, length_bytes)`.
  - Not larger: write `length_bytes` and continue.
  - Larger, but by no more than 64 MB (the size YTS lists often leaves out the small files bundled with the film): write `length_bytes`, continue, and don't check space again.
  - Larger by more than 64 MB: call `storage_admit(difference)` in a transaction. If admitted, write `length_bytes` and continue; if not, write `length_bytes`, stop, and mark it failed (`SIZE_MISMATCH`). On a later retry, the requirement is computed with the larger number.
- **Is there a video**: find the largest video file (`.mp4`, `.mkv`, `.avi`, `.mov`, `.m4v`, `.webm`). If there is none, mark it failed (`NO_VIDEO_FILE`).

If all three checks pass:

- Download all files (YTS torrents are usually one video file plus a few very small extra files); no file selection.
- Set `phase` to `data`.

If any check fails, go through "Cleaning up after a failure" below: **stop, but delete nothing.** The part already downloaded stays, the row stays, and a person decides whether to remove it or (after freeing up space) retry.

### Events

| Event | What to do |
| --- | --- |
| `infoHash` | Nothing (in tests, `addPeer` is only allowed after this) |
| `metadata` | The previous section |
| `download` | Only update the in-memory "time of last progress"; don't write the database every time |
| `wire` | When `wire.type` is `tcpIncoming`, record the time of "the most recent incoming connection" (written to the heartbeat's `info`). `utpIncoming` doesn't count: uTP runs over UDP, and after we connect out, NAT temporarily lets the other side connect back, which doesn't prove the port is forwarded (tested in phase 0) |
| `noPeers` | Write a debug log. Whether it fails is decided by the stall check |
| `warning` | Write a warn log; no handling |
| `error` | A fatal error for this download. `ENOSPC` is marked `DISK_FULL`, anything else `IO_ERROR`. Go through "Cleaning up after a failure" |
| `done` | See "Completion" |

### Writing progress

Every 2 seconds, for each active download, write: `progress`, `downloaded_bytes`, `uploaded_bytes`, `download_bps`, `peers`, and update `last_progress_at` when there is new data; then `NOTIFY paiban_events` (type `torrent`). For downloads that are seeding, only update `uploaded_bytes`, with no notification.

### Stalls

| Case | Threshold | Result |
| --- | --- | --- |
| Never gets the torrent info | 5 minutes | Failed, `METADATA_TIMEOUT` |
| Has the torrent info but no new data | Setting `downloads.stallMinutes`, default 30 minutes | Failed, `STALLED` |

### Cleaning up after a failure

Whatever the failure (stall, no torrent info, size mismatch, no video file, unsafe path, disk error), the steps are the same:

1. Save the bitfield (if the torrent info has already arrived).
2. `destroy({ destroyStore: false })`: leave the client, keeping the files on disk.
3. Measure the folder's actual size and write it to `disk_bytes`.
4. `state = 'failed'`, `error_code`, `error_message` (in English, for logs and administrators), `clean_stop = true`, and reset speed and peer count to zero.
5. Write a `download.failed` notification for each holder; `NOTIFY` (`torrent`, `usage`, and one `notification` per notification).

The slot goes to the next one. **A failure never deletes anything**: the leftovers count toward usage as "Left over from failed downloads" until someone presses Remove.

### Retrying

A retry is started by `api`: after passing admission in a transaction, it sets `state` to `queued`, `want` to `run`, `queued_at` to now (back to the end of the queue), and clears the error. When its turn comes, `torrent` resumes from the downloaded part using the saved bitfield.

## Adding by hand (Brian, 2026-10-09; D26)

The user pastes a magnet link or uploads a .torrent file in the "Add a torrent by hand" window ([11-pages.md](11-pages.md)).

**Reading (`api`)**:

- From a magnet link, take only the info hash (`btih`, hex or base32) and the trackers. A .torrent file is at most 4 MB, and only BitTorrent v1 is supported; keep only the info dictionary, re-encode it as `{info}` and store it, confirming the info hash is unchanged.
- Tracker filtering: keep only `udp`, `http(s)` and `ws(s)`; the host must not be localhost, a private or reserved address, or a single-label internal host, and the URL must not contain a username or password; at most 20. Web seeds (`ws`, `url-list`) and fields like `x.pe` are always dropped, so WebTorrent never connects to any URL the user wrote.
- Write a `torrent_inspections` row. A .torrent file is `ready` immediately; a magnet link is `pending`, with `NOTIFY paiban_inspect`. If an info dictionary is already stored for the same info hash (already on the site, or read before), it is `ready` immediately without asking the swarm.
- Each person can read at most 30 per hour (`RATE_LIMITED`).

**Getting the torrent info (`torrent`, `Inspector`)**:

- On a notification or every 2 seconds, take the oldest `pending` (at most 3 at a time) and add it to WebTorrent with **memory** as storage and no pieces selected; once the metadata arrives, leave, write `{info}` back, and mark it `ready`. If nothing arrives within 2 minutes, mark it `failed` (`NO_METADATA`). Nothing is written to disk.
- When the service restarts, those still `pending` are marked `failed` directly (they are not resumed).

**Adding (`api`, `POST /api/torrents/manual`)**:

- A film must first be chosen on TMDB ([04-api.md](04-api.md)). Title, year, runtime, genres, overview (Chinese and English), poster and IMDb ID come from TMDB. If the IMDb ID matches a film already on the site (for example the YTS row), it goes under that row; otherwise create a film row with an empty `yts_id`, with only one row per TMDB ID.
- The file to download is the largest video file (`.mp4`, `.mkv`, `.avi`, `.mov`, `.m4v`, `.webm`); a torrent with no video file (`NO_VIDEO_FILE`) or with a path that leaves the folder (`UNSAFE_PATH`) can't be added.
- Reserved space: the size of that file plus the preview reservation. Estimating direct play: only a file name that looks like x264, 8-bit and is `.mp4` or `.m4v` counts as playable; everything else reserves a preview file up front ([10-storage.md](10-storage.md)).
- The version (quality, source, codec, bit depth) is guessed from the torrent name and file names, used only for display and estimates.
- `torrents.origin = 'manual'`, `metainfo` is `{info}`, and `trackers` is the filtered trackers. The used `torrent_inspections` row is deleted (it is a data row, not a file). A copy of the poster is fetched from TMDB and stored at `/data/posters/tmdb-<id>.<extension>`, served by `GET /api/movies/:id/poster`.

**Downloading**:

- Starts from the stored `{info}` (no need to get metadata again), with its own trackers.
- At first no pieces are selected; as soon as the metadata comes in (before WebTorrent checks the pieces already on disk), select only the largest video file and the subtitle files beside it (`.srt`, `.ass`, `.ssa`, `.vtt`, each at most 5 MB, at most 50; after the download, `media` adds them as subtitles, see "1b. Subtitles from the torrent (Brian, 2026-10-09)" in [08-media-pipeline.md](08-media-pipeline.md)). Progress, size and completion are all based on these files together: WebTorrent's torrent as a whole never "completes", so wait for each one's `done`. The reserved space is likewise the video plus these subtitle files.
- Neighboring files that share the first or last piece with the selected files get that small part written; other files don't appear. `disk_bytes` still measures the whole folder.
- Everything else (scheduling, pausing, failure, seeding, removal) behaves the same as for YTS downloads.

## Pausing

1. Not yet added to the client (`queued`): set `state` to `paused` directly.
2. Active: save the bitfield → `destroy({ destroyStore: false })` → in the callback, set `state` to `paused` and `clean_stop = true`.

A paused download keeps holding its reserved space (the interface says "Paused; the space is still reserved").

## Completion

When the `done` event fires:

1. Decide from the seeding setting whether to stay in the client (next section).
2. Measure the actual size of `/data/torrents/<hash>`.
3. In **one transaction**:
   - `state = 'completed'`, `progress = 1`, `disk_bytes`, `completed_at`, `bitfield = null`
   - Create `media_files`: the main video file's relative path and size; `direct_play` starts as the value predicted from YTS data; `analysis_state` is `pending` or `none` depending on the **current** setting `media.analyzeAuto`
   - The preview part is carried over from **the plan fixed when the download was admitted**, without looking at the settings again (D40): `reserve_bytes = preview_reserve_bytes`; when this value is greater than 0, `audio_state = 'pending'`; when `preview_proxy_res` has a value, `proxy_state = 'pending'` and `proxy_res` is that value. Then reset `torrents.preview_reserve_bytes` to zero
   - Write a `download.completed` notification for each holder. Don't wait for analysis: the film can already go into the workspace to look for subtitles
4. `NOTIFY paiban_media` (telling `media` to probe this file and queue analysis and preview assets) and `NOTIFY paiban_events` (`torrent`, `usage`, and one `notification` per notification).

`torrent` doesn't touch the job queue. It only writes rows as "waiting"; `media`'s reconciliation step queues the jobs for it ([02-architecture.md](02-architecture.md)).

Phase 3 has no `media` program yet. In that phase, always write `analysis_state` as `none`, so the status goes straight to "Done" once the download completes; preview assets are written as "waiting" as above, just with no one processing them yet. Only after `media` is added in phase 4 does `analysis_state` follow the setting ([14-plan.md](14-plan.md)).

## Seeding

Setting `downloads.seedMode`:

| Value | Behavior |
| --- | --- |
| `stop` (default) | On completion, `destroy({ destroyStore: false })`; no more uploading |
| `ratio` | Stays in the client and keeps uploading, `seeding = true`; when the upload amount reaches the file size (share ratio 1.0), stop and set `seeding` back to false |

Uploading already happens during the download; this setting only decides what happens after completion. While seeding, `uploaded_bytes` is still updated every 2 seconds, and the share ratio is it divided by the file size.

When the program restarts, those with `seeding = true` are added back with `skipVerify: true`.

## Removal

For rows with `want = 'remove'`, whatever their current state:

1. If it is in the client, `client.remove(hash, { destroyStore: true })`. This is also a kind of deletion: this call must live in the single deletion module (or be wrapped by it), not scattered elsewhere ([10-storage.md](10-storage.md)).
2. Follow "What happens when a download is deleted" in [03-data-model.md](03-data-model.md): delete all related folders; in one transaction, mark this film's unfinished exports as failed, mark its other unfinished `tasks` as cancelled, and delete this row. No need to wait for `media`: jobs processing this film stop on their own and leave nothing behind.
3. `NOTIFY`: `torrent.removed`, `usage`, plus one each for the changed jobs, exports and newly written notifications (the list is in the same section of 03).

## Live view (download details page)

While the download details page ([11-pages.md](11-pages.md)) is open, every time `api` is asked `GET /api/torrents/:id/live`, it sets `torrent_live.wanted_until` to 10 seconds later. At the end of each main loop round (2 seconds), write a snapshot to `torrent_live.data` for downloads whose `wanted_until` hasn't passed; nothing is written for downloads no one is watching. `api` returns only a snapshot written within the last 6 seconds, otherwise `null` (not ready yet, or the download isn't running).

The snapshot (`TorrentLive`) is read from WebTorrent (`snapshot()` in `engine.ts`; all internal fields are wrapped in this one file):

- Each connection: address (masked as "61.220.x.x" before leaving this service), country, whether it is on the LAN, client name (`v` from the other side's extended handshake, or decoded from "-qB4630-" in the peer id when absent), who connected to whom, TCP or uTP, speed, and what share the other side has.
- Each piece: completed, currently being requested from some peer (`_reservations` not empty), and how many connected peers have it (at most 255).
- Speed over the last two minutes: one point per round, kept only in memory, at most 60 points per film.

Countries come from DB-IP's free "IP to Country Lite" (CC BY 4.0), downloaded to `/opt/geo` (`GEOIP_CSV`) when building the image; lookups make no outside connections. It loads in the background at startup (about 7 seconds and about 100 MB of memory on this machine), and peers have no country before it loads. IPv6 matches only the first 64 bits: no country is allocated a range smaller than /64. The server's own location (Brian, 2026-10-06: detect automatically) never asks any outside service: peers say in the extended handshake which public address they see us at (`yourip` in BEP 10; qBittorrent, Deluge and Transmission send it, WebTorrent doesn't). Each peer's report counts as one vote, its country looked up in the same DB-IP table, and the country with the most votes is where the server is (`HomeFinder` in `live.ts`); the same peer present every round still counts as one vote; on a tie the current country stays, so the map doesn't jump back and forth; LAN addresses and addresses with no country don't count. It is kept only in memory, recording reports from at most 200 peers. Before any peer has reported (just started, or connected only to WebTorrent clients), the country comes from `TZ` (the table in `live.ts`; unrecognized time zones are treated as Taiwan). Snapshots are read only while someone has the download details page open, so votes are also collected only then. `TorrentLive.homeFrom` says which it is (`peers` or `timezone`).

## Restarts

On startup:

| State in the database | What to do |
| --- | --- |
| `downloading`, `clean_stop = true`, has a bitfield | Add back with the bitfield (fast resume) |
| `downloading`, any other case | Add back without a bitfield. WebTorrent re-verifies all the data on disk (`phase = 'verifying'`): slow, but always correct |
| `completed` and `seeding = true` | Add back with `skipVerify: true` |
| `want = 'remove'` | Continue removing |
| Anything else | Leave it for the main loop |

On SIGTERM: stop scheduling → for each active download, save the bitfield, `destroy({ destroyStore: false })`, `clean_stop = true` (`state` stays `downloading`, so the next startup resumes it) → `client.destroy()` → exit. All of this must finish within 25 seconds.

The point of `clean_stop`: a bitfield can only be trusted if "nothing was written to disk after it was saved". When the program is killed or loses power, it is better to spend the time re-verifying than to trust a bitfield that may not match the disk.

## Incoming connections

This program can't test itself from outside (that would need a third-party service). It observes instead: if any `tcpIncoming` connection has ever come in, the port is open (`utpIncoming` doesn't count, for the reason above). The "time of the most recent incoming connection" is written to `service_heartbeats.info`, and the admin page shows it as:

- "Incoming connections seen in the last 24 hours": fine.
- "No incoming connections seen yet": the port may not be open. Explains that `TORRENT_PORT` (TCP, UDP) and `TORRENT_DHT_PORT` (UDP) must be opened in Docker and on the router. Downloads still work without it, just more slowly.

## Boundaries

- This program handles only info hashes already in the database, and magnet links in `torrent_inspections` waiting for their torrent info. Torrents only come in through `api`'s two entry points (D26).
- It doesn't need, and can't get, `SECRET_KEY`.
- It deletes nothing whose `want` is not `remove`. A failed download keeps its leftovers until someone presses Remove.
- Only `api` writes `want`, and every write of `remove` corresponds to an action someone pressed (the last holder removing it, or an administrator force deleting it).

## Tests

- **Unit**: scheduling rules (site-wide limit, per-person limit, skipping and not skipping), stall detection, path checks. Replace WebTorrent with a fake object.
- **Integration**: following `reference/torrent/local-swarm-test.mjs`, start a seeding client in the test and have the `torrent` program download `fixtures/clip.mp4`. Cover: download completes and creates `media_files`; pause then resume; kill the program and resume after restart; the folder disappears after removal; failure when the torrent is larger than listed and there isn't enough space (with the downloaded part still there and usage counting the leftovers); retry after failure resumes from the downloaded part.
- In tests, turn off DHT, trackers and LSD, and use only `addPeer('127.0.0.1:<port>')`. For this the program has a hook enabled only in development and testing: the environment variable `TORRENT_TEST_PEERS`. If it is set when `NODE_ENV=production`, the program refuses to start ([02-architecture.md](02-architecture.md)).
