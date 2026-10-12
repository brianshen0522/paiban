# 04 API

The request and response **shapes** of every endpoint are in `packages/shared/src/contracts/api.ts` (checked in TypeScript 7 strict mode). This document explains each endpoint's **behavior**: who may call it, what it does, and which errors it returns. The two are changed together; when they truly don't match, this document wins for behavior and the contract wins for shape.

## Common rules

- All endpoints are under `/api`, JSON, UTF-8.
- Sizes are always integer bytes; times are ISO 8601 UTC strings; film lengths and subtitle times are seconds (floating point). Turning bytes into "1.6 GB" is the frontend's job.
- **The API doesn't produce sentences for people to read.** It returns codes and data (film titles, file names, version names, numbers), and the frontend builds the interface text from the codes. The only free text is `ApiError.message` and `Torrent.error.message`, both in English, for logs and administrators, never shown directly.
- Sign-in state is kept in a cookie (details in [12-auth.md](12-auth.md)).
- Except for endpoints marked "Public" below, all require sign-in; without it they return `401 UNAUTHENTICATED`.
- Endpoints marked "Administrator" return `403 FORBIDDEN` when a member calls them.
- For endpoints marked "Holder", the caller must be a holder of that film, otherwise they return `403 NOT_HOLDER`. **Administrators too**: to work on someone else's film, they first add that version to their own library (`POST /api/torrents`). Subtitle and video endpoints are checked against the film they belong to. Administrators have only three things more than members: `/api/admin/…`, the site-wide download and export lists (`scope=all`), and anyone's exports.
- A download being deleted (`want = 'remove'`) no longer exists for any endpoint: they return `404 NOT_FOUND`, and lists leave it out.
- Requests that change data (`POST`, `PUT`, `PATCH`, `DELETE`) must carry the `X-Requested-With: paiban` header, and `Origin` is checked to be same-origin with `PUBLIC_URL` (or equal to the request's `Host`); otherwise they return `403 FORBIDDEN`. This is for cross-site request protection. Requests with a body must also carry `Content-Type: application/json` (uploads use `multipart/form-data`); requests without a body (for example pause, delete) don't need `Content-Type`.
- `GET` doesn't change data. There are two exceptions, both only records, not users' data: `sessions.last_seen_at` and `torrents.last_used_at`.
- A request body that doesn't match the schema returns `422 VALIDATION`, with `details.fields` saying which field and why (the reason is a code, not a sentence).
- Error responses always have the shape `ApiError`.

## Endpoints

### Health check

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/health` | Public | Returns `{ok: true}` if the database is reachable. For compose's healthcheck; reveals nothing else |

### Sign-in and accounts

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `POST /api/auth/login` | Public | Username is case-insensitive. On success, creates a session and sets the cookie. Wrong credentials always return `INVALID_CREDENTIALS`, without saying whether the username or the password was wrong; a disabled account returns `ACCOUNT_DISABLED`; too many attempts return `RATE_LIMITED` |
| `POST /api/auth/logout` | Signed in | Deletes the current session |
| `GET /api/auth/me` | Signed in | The current user, site name, upload size limit, number of checkpoints, site-wide concurrent downloads. The frontend calls it on startup to tell whether it is signed in |
| `GET /api/invites/:code` | Public | Used by the registration page to check the invite code first. `INVITE_NOT_FOUND`, `INVITE_EXPIRED`, `INVITE_USED` |
| `POST /api/auth/register` | Public | Creates an account with an invite code and signs in directly. The invite code is marked used in the same transaction. `USERNAME_TAKEN`, the three invite code errors, `VALIDATION` |
| `GET /api/auth/reset/:token` | Public | Checks whether the reset link is still valid and returns the account name for the page to show. `RESET_INVALID` |
| `POST /api/auth/reset/:token` | Public | Sets the new password, invalidates the link, and signs out all of this account's sessions |
| `PATCH /api/me` | Signed in | Changes the display name or preferences. `prefs.langs` must have at least one entry; `prefs.locale` is the interface language, `'zh-TW'`, `'en'` or `null` (follow the browser); `prefs.posterRegion` is the poster country (`TW`, `HK`, `CN`, `US`, `JP`, `KR`; `null` follows the interface language) |
| `POST /api/me/password` | Signed in | Must include the current password (`WRONG_PASSWORD` if wrong). On success, all other devices are signed out |
| `GET /api/me/sessions` | Signed in | Signed-in devices. The operating system and browser names are derived from the User-Agent at sign-in; null when they can't be derived |
| `DELETE /api/me/sessions/:id` | Signed in | Signs out that device. Can't be used to sign out the current one (use logout); trying anyway returns `VALIDATION` |

### Search

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/yts/movies` | Signed in | Forwards to YTS's `list_movies`. Without `q`, it is "Recently added". 24 films per page. Results are cached for 10 minutes. Returns `YTS_NOT_CONFIGURED` when the YTS URL isn't set yet, `YTS_UNREACHABLE` when it can't connect, `YTS_BAD_RESPONSE` when the response can't be understood. Each film is marked with whether the caller has it (`mine`) |
| `GET /api/yts/movies/:ytsId` | Signed in | Film data plus every version. There are two synopses: `summary` (TMDB's Chinese synopsis, or YTS's English synopsis when there is none) and `summaryEn` (YTS's English synopsis, for the English interface). Each version comes with: whether it plays directly, how much preview space to reserve, the total needed, whether it fits right now, and whether someone on the system has already downloaded it. Current usage is returned too. When YTS can't be reached and previously stored data exists for this film, it is returned as usual with `stale` true and `fetchedAt` the time of that data; only when nothing was stored does it return `YTS_UNREACHABLE` |
| `GET /api/yts/movies/:ytsId/poster` | Signed in | The server fetches the poster from TMDB (or YTS when there is none) and returns it. `region` is which country's poster (`TW`, `HK`, `CN`, `US`, `JP`, `KR`, default `TW`; see "Posters" in [05-yts.md](05-yts.md)). Films in the library are read from `/data/posters`. Returns 404 when it can't be fetched, and the frontend draws a placeholder poster instead |
| `GET /api/tmdb/suggest?q=` | Signed in | Suggestions while typing (Brian, 2026-10-06): searches TMDB for films (`language=zh-TW`, matching both Chinese and original titles), at most 8, `{items: TmdbSuggestion[], available}`. With no TMDB key, or when TMDB errors, `available: false` and the list is empty (search isn't blocked). `q` is 1 to 100 characters. Results are cached for a day |
| `GET /api/tmdb/:tmdbId/yts` | Signed in | After a suggestion is clicked: asks TMDB for the film's IMDb id (`/3/movie/<id>/external_ids`, cached for a month), then looks it up on YTS by that id (`query_term` understands IMDb ids; results cached for an hour). `{ytsId, imdbCode}`; `ytsId` is null when YTS doesn't have the film, and both are null when TMDB doesn't know the IMDb id either |
| `GET /api/tmdb/poster/:file` | Signed in | Small posters for the suggestion list, fetched by the server from `image.tmdb.org/t/p/w92/…` (D30). The file name is accepted only in the form of a TMDB poster path (something like `[\w-]+.jpg`); anything else returns `VALIDATION` |

Details are in [05-yts.md](05-yts.md).

### Downloads

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `POST /api/torrents` | Signed in | See "Admitting a download" below |
| `GET /api/torrents` | Signed in | `scope=mine` (default) returns all downloads the caller holds, whatever their status; `scope=all` returns the whole site's, administrators only |
| `GET /api/torrents/:id` | Holder | |
| `POST /api/torrents/:id/pause` | Holder | Only `queued` and `downloading` can be paused; others return `TORRENT_STATE`. The space stays reserved |
| `POST /api/torrents/:id/resume` | Holder | Only `paused` can be resumed. Goes back to the end of the queue |
| `POST /api/torrents/:id/retry` | Holder | Only `failed` can be retried. Space is checked again: the need is the full size plus the preview reservation, minus the leftovers already on disk; if not enough, returns `STORAGE_LIMIT`. Once it passes, it goes back to the end of the queue and continues from what was already downloaded |
| `POST /api/torrents/:id/hold` | Signed in | Joins a film someone else has already downloaded ("Add to my library" in "All films"). Doesn't ask YTS again (the row was originally created from a YTS result or by adding by hand), doesn't check space, takes no space (D21). If the caller is already a holder, returns the current state. Being deleted or nonexistent returns `NOT_FOUND`. Returns `Torrent` and writes the activity log entry `torrent.join` |
| `DELETE /api/torrents/:id/hold` | Holder | Removes the caller from the holders. Others still hold it: `{deleted: false, freedBytes: 0}`. The caller was the last holder: the whole film, together with its subtitles, preview files and **all of this film's exports**, is queued for deletion (Brian, 2026-10-06), `{deleted: true, freedBytes}`, where `freedBytes` includes the exports. For exports someone else created, the creator receives `item.deleted` |
| `POST /api/torrents/inspect` | Signed in | First step of adding a torrent by hand (D26; [06-torrent-worker.md](06-torrent-worker.md), "Adding by hand (Brian, 2026-10-09; D26)"). JSON `{magnet}`, or multipart with one field `file` (.torrent, at most 4 MB). Returns `TorrentInspection` (201): a magnet link is usually `pending`, and the next endpoint must be polled. If it can't be understood, returns `TORRENT_INVALID` with `details.reason` `BAD_MAGNET` or `BAD_TORRENT`. 30 times per person per hour; beyond that, returns `RATE_LIMITED`. When the torrent is already on the site, `existing` is that download |
| `GET /api/torrents/inspect/:id` | Creator | That entry's current state: `pending`, `ready` (`file` is the file that will be downloaded, `skippedFiles` is the number of files not downloaded, `version` and `guess` are the version and film title guessed from the name), `failed` (`errorCode`: `NO_METADATA`, `NO_VIDEO_FILE`, `UNSAFE_PATH`, `BAD_TORRENT`). Someone else's returns `NOT_FOUND` |
| `POST /api/torrents/manual` | Creator | `{inspectionId, tmdbId}`. Still `pending` returns `TORRENT_STATE`; `failed` returns `TORRENT_INVALID`; older than 24 hours returns `NOT_FOUND`. Fetches the film from TMDB (no key returns `TMDB_NOT_CONFIGURED`, unreachable returns `TMDB_UNREACHABLE`, no such film returns `VALIDATION`). If the same info hash is already on the site, joins as a holder (`joined: true`, no space check); otherwise in a transaction `storage_admit(file size + preview reservation)`, returning `STORAGE_LIMIT` if not enough, and creates the film (if needed), the download and the holder. Returns `{torrent, joined}` (201 for new, 200 for joined) and writes the activity log entry `torrent.manual` or `torrent.join` |
| `GET /api/movies/:id/poster` | Signed in | The TMDB poster of a film added by hand, `region` as above; fetched posters are stored in `/data/posters`. Returns 404 when there is none, and the frontend draws a placeholder poster |

**Admitting a download** (`POST /api/torrents`), in order:

1. If the YTS URL isn't set yet, return `YTS_NOT_CONFIGURED`. Use `ytsId` to get the film's data from YTS (or the cache) and confirm `infoHash` is in its list of versions. If not, return `HASH_NOT_FROM_YTS`. **Size, quality and codec always come from what the server looked up; no other value in the request is used.**
2. In a transaction, find the row for this info hash and lock it:
   - Exists, but is being deleted (`want = 'remove'`): return `TORRENT_STATE`. The interface asks the user to try again later.
   - Exists: add the caller as a holder and return `{torrent, joined: true}`. No space check. If it is `failed`, it isn't retried automatically; after joining, the user can press retry themselves.
3. Doesn't exist: compute the need (video size + preview reservation). The preview reservation is computed from the settings **at that time**, and whether to make a preview video and at what resolution is decided along with it (D40). Call `storage_admit` in the same transaction. If not enough, return `STORAGE_LIMIT`, with `details` carrying the need, the remaining space, the shortfall, and how much of it is for the preview. If the disk itself doesn't have enough free space, return `DISK_FULL`.
4. Passed: create the film (if missing), the download and the holder, return `{torrent, joined: false}`, and notify `torrent`.

### Library

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/library` | Signed in | Films the caller holds that have finished downloading (including those still being analyzed), each with the number of subtitles and exports, the languages of confirmed subtitles (`confirmedLanguages`) and the "next step". Filtering is done in the frontend. `scope=all` returns every finished film on the site, available to everyone signed in (Brian, 2026-10-09, "All films"); `torrent.mine` says whether the caller holds it |
| `GET /api/library/:torrentId` | Holder | Everything the workspace needs in one go: the film, its subtitles, its exports, current usage, and how much space one export needs. Not yet finished downloading returns `MEDIA_NOT_READY`. **It doesn't start analysis**: when automatic analysis is off, the frontend sees `analysis` as `none` and calls `POST /api/media/:id/analyze` once itself |

### Videos

`:id` is `media_files.id`.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/media/:id` | Holder | The state of each asset, the latest errors, how much the preview file takes, how much making the preview file afterwards would need, and which source the workbench should use (see [09-sync-workbench.md](09-sync-workbench.md)) |
| `GET /api/media/:id/original` | Holder | The original file. Supports Range |
| `GET /api/media/:id/proxy` | Holder | The preview file. 404 if there is none |
| `GET /api/media/:id/audio` | Holder | The audio file. 404 if there is none |
| `GET /api/media/:id/peaks` | Holder | The waveform binary. Returns `MEDIA_NOT_READY` while analysis is waiting or in progress; 404 when analysis is over but the file doesn't exist (failed, or never requested) |
| `GET /api/media/:id/speech` | Holder | Speech regions. Same as above |
| `POST /api/media/:id/analyze` | Holder | Queues analysis: when `analysis` is `none` or `failed`, sets it to `pending` (if the probe failed before, the probe is redone too). If already waiting, in progress or done, returns the current state |
| `POST /api/media/:id/proxy` | Holder | Requests the preview assets. A file that plays directly returns the current state. Otherwise sets whichever of the audio file and preview video is `none` or `failed` to `pending` (the preview video's resolution uses the current settings), and the two reservations go through admission together; if not enough, returns `STORAGE_LIMIT`. If the probe failed before, the probe is redone too. If nothing is missing, returns the current state |

Requirements for streaming endpoints: support `Range`, `If-Range`, `HEAD`, return `Accept-Ranges: bytes`, `Cache-Control: private, no-store`. `Content-Type` depends on the container: `video/mp4`, `video/x-matroska`, `video/webm`; the audio file is `audio/mp4`. File paths come only from the database; no path fragment from the request is accepted.

### Subtitles

`:id` is the download's id in `/api/torrents/:id/...`, the subtitle's id in `/api/subtitles/:id`, and the candidate's id in `/api/candidates/:id`.

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/torrents/:id/candidates` | Holder | Each source's status, the candidate list, whether ranking is in progress, and Zimuku's search link |
| `POST /api/torrents/:id/subtitle-search` | Holder | Queues one query for each enabled source and **returns immediately** (each source is `running`; the response is read before any source starts running, so it is always `running`, even for a source that finishes right away, such as Assrt (Shooter) without a token). Sends a `candidates` event as each source finishes. With `provider`, only that one is queried. Uses the cache when there is an unexpired one; `refresh: true` skips the cache ("Search again" and "Retry" both send it) |
| `POST /api/torrents/:id/candidates/rank` | Holder | Fetches all candidates in the chosen languages (at most 30), auto-aligns each once, and ranks them by score. When Traditional Chinese is chosen, all of the film's Chinese candidates are included. Returns immediately; progress comes through `candidates` events. With no speech data (analysis isn't ready yet, or it failed), returns `MEDIA_NOT_READY`; in that case the interface already disables the button and explains why. If a ranking is already running, returns the current state without starting another |
| `POST /api/torrents/:id/uploads` | Holder | Uploads one subtitle file or archive, limit 20 MB. A wrong extension returns `UNSUPPORTED_FILE`, too large returns `UPLOAD_TOO_LARGE`. As soon as the file is received, a "Processing…" candidate appears on the list; the content is processed in the background, and if it can't be read, that candidate becomes failed with a reason (`fetchError`) |
| `POST /api/candidates/:id/add` | Holder | Adds the candidate to the film. If it hasn't been fetched, it is fetched first, **waiting at most 30 seconds**. If it can't be fetched, returns `CANDIDATE_UNAVAILABLE` with `details.reason` as the reason: the candidate's `fetchError`, or `TIMEOUT` (still fetching in the background; press again a bit later). When `convertToTraditional` isn't given, the caller's preference is used. Content identical to existing subtitles returns `SUBTITLE_DUPLICATE` |
| `DELETE /api/candidates/:id` | Holder | Removes a candidate from the list, along with the file it fetched. Mainly for clearing failed uploads. Subtitles already added aren't affected |
| `GET /api/torrents/:id/subtitles` | Holder | The film's added subtitles |
| `GET /api/subtitles/:id` | Holder | The subtitles, the list of lines, the sync doc |
| `PUT /api/subtitles/:id/doc` | Holder | Saves the sync doc. If `rev` differs from the one in the database, returns `REVISION_CONFLICT`, with `details` carrying the current `rev`, `doc` and the person who last changed it. When `segments` or `edits` differ from those in the database, the status goes back to draft; touching only anchors or checkpoints doesn't. Every save recomputes the score and notifies the other holders' screens. With `reason` (`auto-align` or `reset`), a history entry is saved as well |
| `POST /api/subtitles/:id/auto-align` | Holder | Computes the suggested segments and returns them **without changing the stored doc** (the frontend applies them and then saves, so it can be undone). With no speech data, returns `MEDIA_NOT_READY`. When the subtitles and the film are in different languages and a language model is set up, the language model first matches the recognition results (at most 45 seconds; see "Language model" in 08). The job usually takes 1 to 5 seconds, and the endpoint waits for it before responding; when both methods fail, or there is no result within 60 seconds, returns `ALIGN_FAILED`. The result's `heard` says what speech recognition contributed. With `referenceId` (other subtitles of the same film), it aligns by those subtitles instead: no speech data needed, no language model used; the result's `reference` says how it was aligned, and `extraLines` lists the lines suggested for deletion (see "Align by other subtitles" in 08); anything that isn't other subtitles of the same film returns `VALIDATION` (`fields.referenceId`). At most 20 times per person per 10 minutes; beyond that, returns `RATE_LIMITED` (`details.retryAfterSeconds`) |
| `POST /api/subtitles/:id/confirm` | Holder | `rev` must be the latest (otherwise returns `REVISION_CONFLICT`). While some checkpoints haven't passed, it is accepted only with `force: true` (the frontend asks the user first); without it, returns `VALIDATION` with `details.fields` as `{force: 'CHECKPOINTS_PENDING'}`. On success the status is confirmed, a history entry is saved, and the other holders are notified |
| `GET /api/subtitles/:id/file` | Holder | Downloads the subtitle file (SRT, UTF-8). `synced=true` is the version with the sync doc applied; otherwise the original timing |
| `DELETE /api/subtitles/:id` | Holder | Deletes these subtitles and their sync result. MKVs already exported aren't affected |
| `POST /api/subtitles/:id/translate` | Holder | Starts translating these subtitles ([18-llm.md](18-llm.md)): `{targetLanguage, mode: 'plain' | 'bilingual'}`, returns `Translation` (`running`). No usable profile returns `LLM_NOT_CONFIGURED`; the same subtitles already being translated into the same target language and form returns `TRANSLATION_RUNNING`; exceeding the per-person hourly count returns `RATE_LIMITED` (`retryAfterSeconds`) |
| `GET /api/torrents/:id/translations` | Holder | The film's 30 most recent translations |
| `POST /api/translations/:id/cancel` | Holder | Cancels a running translation; parts already translated are kept, and no subtitles are written out |
| `POST /api/translations/:id/resume` | Holder | A failed or cancelled translation continues from the part where it stopped; doesn't count toward the limit |

Source details are in [07-subtitle-providers.md](07-subtitle-providers.md), and the sync doc is in [09-sync-workbench.md](09-sync-workbench.md).

### Export

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `POST /api/torrents/:id/exports` | Holder | At least one subtitle track, and every one must be a confirmed subtitle **of this film** (otherwise `NO_CONFIRMED_SUBTITLE`); exactly one is the default track, and the same one can't be picked twice (otherwise `VALIDATION`, with `details.fields.tracks` as `ONE_DEFAULT` or `DUPLICATE`); the file name must pass the checks (otherwise `INVALID_FILENAME`, with `details.fields.fileName` as `EXTENSION`, `CHARACTERS` or `TOO_LONG`); a download that isn't finished returns `MEDIA_NOT_READY`. Must pass admission (otherwise `STORAGE_LIMIT` or `DISK_FULL`). On success, returns `201` and the `Export`. The default track comes first in the file, and the others follow the order of the request |
| `GET /api/exports` | Signed in | `scope=mine` (default) returns those the caller created; `scope=all` returns the whole site's, administrators only (members get `FORBIDDEN`). Newest first. The Storage page uses it to list "Exports I made": after the film is deleted, this is the only place its exports can still be downloaded. A single film's exports are in `GET /api/library/:torrentId`. Those already asked to cancel and waiting for `media` to stop are not listed |
| `GET /api/exports/:id/file` | Holders of that film, the creator, or an administrator | Downloads the MKV. Supports Range, with `Content-Disposition: attachment` (`filename` is an ASCII fallback name, `filename*=UTF-8''…` is the original file name). Unfinished ones, or ones the caller can't see, return `NOT_FOUND` |
| `DELETE /api/exports/:id` | Creator or administrator | Done or failed: delete the file and the row. Still queued: delete directly (along with `tracks/`; its `tasks` marked `cancelled`). In progress: request cancellation, deleted after `media` stops. Returns the size freed (the file size for done ones, the reservation for queued or in-progress ones, 0 for failed ones). Other holders of the film get `FORBIDDEN`; people who can't see it get `NOT_FOUND` |

Details are in [08-media-pipeline.md](08-media-pipeline.md).

### Storage, notifications, live updates

| Endpoint | Access | Behavior |
| --- | --- | --- |
| `GET /api/storage` | Signed in | Site-wide usage (everyone sees the same numbers), plus the items the caller holds (videos, reservations for downloads in progress, leftovers from failed downloads, preview files). The caller's own exports come separately from `GET /api/exports` |
| `GET /api/notifications` | Signed in | The latest 50 and the unread count |
| `POST /api/notifications/read` | Signed in | Marks them read |
| `GET /api/events` | Signed in | Server-Sent Events, see below |

### Admin

All administrators only.

| Endpoint | Behavior |
| --- | --- |
| `GET /api/admin/overview` | All data for the Overview page: usage, number of downloads, number of users, background tasks, things that need attention, source status, recent activity |
| `GET /api/admin/users` | Every user, including how many films they hold, how many downloads are in progress, and how many items they hold alone |
| `PATCH /api/admin/users/:id` | Changes role or disables. Can't be done to oneself (returns `FORBIDDEN`); can't leave the system without any active administrator (`LAST_ADMIN`). Disabling immediately signs out all their devices |
| `POST /api/admin/users/:id/reset-link` | Generates a one-time reset link, valid for 30 minutes. The link appears only in this response |
| `DELETE /api/admin/users/:id` | Removes the account. Files they hold are left alone (see [03-data-model.md](03-data-model.md)). Can't remove oneself (`FORBIDDEN`); also subject to `LAST_ADMIN` |
| `GET /api/admin/invites` | |
| `POST /api/admin/invites` | Valid for 1, 3 or 7 days |
| `DELETE /api/admin/invites/:id` | Revokes (unused ones) or clears (used or expired ones) |
| `GET /api/admin/storage` | Usage, disk info, **all** items (largest first), orphans and missing files found by the latest recalculation (`findings`), and that recalculation's job |
| `PUT /api/admin/storage/limit` | See the validation rules in [10-storage.md](10-storage.md). Going below current usage is allowed |
| `POST /api/admin/storage/rescan` | Queues one recalculation and immediately returns that job. If one is already running, returns that one. When done, sends an `admin` event (`storage`), and the page fetches `GET /api/admin/storage` again. **It only updates numbers and reports; it deletes nothing** |
| `DELETE /api/admin/storage/items/:kind/:id` | Force deletes one item, whoever holds it. `movie`, `reserved`, `partial` use the download's id and delete all of this film's exports along with it; `preview` uses the video's id (deletes only the preview video and audio file); `export` uses the export's id; `orphan` uses the finding's id (deletes that folder). Affected people receive notifications |
| `GET /api/admin/settings` | All settings, plus read-only info (which keys are set, the incoming port, the disk) and each source's latest status |
| `PATCH /api/admin/settings` | Send only the parts to change. If any item is invalid, the whole thing is rejected (`SETTING_INVALID`), with `details.fields` saying which |
| `PUT /api/admin/secrets/:name` | Writes a key. It is never shown again |
| `DELETE /api/admin/secrets/:name` | Clears it |
| `POST /api/admin/sources/:id/test` | Actually connects to that source once. **Always returns 200**: failing to connect is the test's result, not this endpoint's error. Returns `{ok, code, data, ms}` and updates that source's status |
| `GET /api/admin/llm` | LLM settings page: profiles (including cooldown state, excluding keys), the latest 50 usage records, `translatePerHour` |
| `POST /api/admin/llm/profiles` | Adds a profile. `key` is stored only if it has a value; wrong fields return `VALIDATION` (`baseUrl`: `REQUIRED`, `URL_FORMAT`; `model`: `REQUIRED`) |
| `PUT /api/admin/llm/profiles/:id` | Edits. `key` omitted means unchanged, `null` means clear, a string means replace; saving clears its cooldown |
| `DELETE /api/admin/llm/profiles/:id` | Deletes |
| `POST /api/admin/llm/models` | Asks the service for its model list using the form's URL and key (falling back to those stored in `profileId` when not filled in). If it can't get one, returns `VALIDATION` with `fields.model` as the reason (`AUTH`, `UNREACHABLE`…) |
| `POST /api/admin/llm/test` | Sends one small translation using the form's current values (saved or not), returns `LlmCheck`, and records one usage entry with the purpose "test" |
| `PUT /api/admin/llm/settings` | `{translatePerHour}` |
| `GET /api/admin/system` | Each service's heartbeat, the latest 50 background tasks, disk info |
| `POST /api/admin/tasks/:id/retry` | Reruns a failed job. Only for analysis, preview assets and recalculation (`Task.retryable`); preview assets must pass admission again, and return `STORAGE_LIMIT` if not enough. Alignment, ranking and export can't be rerun this way (returns `VALIDATION`): alignment and ranking are pressed again by the user, and an export is created anew |
| `GET /api/admin/audit` | Activity log, 50 per page, paging back with `before` |

## Live updates

`GET /api/events` is one Server-Sent Events connection. Each message is the JSON of one `ServerEvent`.

- After the connection opens, one comment (`: ok`) is sent first, then a heartbeat comment every 25 seconds, so proxies in between don't close the connection.
- Events go only to people allowed to see that data: download, candidate and subtitle events go to holders (when an administrator's Downloads page has "Show everyone's downloads" checked, it updates by refetching the list, with no separate push); export events go to the film's holders and the creator; `usage` goes to everyone; `notification` goes only to the person concerned; `admin` goes only to administrators.
- Two exceptions: `torrent.removed` and `export.removed` go to everyone. By the time the notification arrives, the row and its list of holders are already gone, so there's no way to look up who to send it to; the event carries only an id and reveals no content, and a client that doesn't have that id ignores it.
- **Progress frequency**: at most one `torrent` event per second for the same download. The `torrent` program writes progress to the database every 2 seconds, so the screen updates roughly every 2 seconds.
- Events are "reminders", not the only source of data. After reconnecting, the frontend refetches the data the current screen needs, without relying on replays.

What the frontend does: on receiving an event, it updates the TanStack Query cache (events carrying full data are written directly; events carrying only an id invalidate the matching queries).

### Notifications between servers

`api` learns what the other services did through `LISTEN paiban_events`. A `NOTIFY` payload is only `{type, id}`; `api` looks up the data itself. Changes `api` makes itself (for example saving a sync doc) don't go through here; it sends the events directly.

| `type` | `id` | Sent by | What `api` does on receipt |
| --- | --- | --- | --- |
| `torrent` | download | torrent, media | Reads the download (including the state of each video asset) → `torrent` event. Analysis and preview file progress also go through this one |
| `torrent.removed` | download | torrent | `torrent.removed` event |
| `candidates` | download | media | `candidates` event. When query jobs that `api` handles itself finish, it sends this event directly, without a round trip |
| `export` | export | media, torrent | `export` event. `torrent` sends it in only one case: when the film is removed and it marks unfinished exports failed |
| `export.removed` | export | media | `export.removed` event |
| `task` | task | media, torrent | Wakes up requests waiting for this job's result; `admin` event (`tasks`) |
| `notification` | notification | torrent, media | `notification` event, sent to the notification's recipient |
| `usage` | (empty) | torrent, media | Recomputes usage → `usage` event |
| `storage` | (empty) | media | Recalculation is done: `admin` event (`storage`) and `usage` event |

Actions that change usage (completion, failure, deletion, preview file done, export done) send an extra `usage` besides their own message. Service heartbeats don't go through notifications; the System status page refetches every 10 seconds while open.

## Error codes

| Code | HTTP | When | How the interface handles it |
| --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | Not signed in, or the session expired | Go to the sign-in page, and back to the original page after signing in |
| `INVALID_CREDENTIALS` | 401 | Wrong username or password | Show "Wrong username or password." in the sign-in form |
| `FORBIDDEN` | 403 | Not an administrator; or the cross-site header is missing | "Only administrators can see this page." |
| `ACCOUNT_DISABLED` | 403 | The account is disabled | "This account has been disabled. Contact an administrator." |
| `NOT_HOLDER` | 403 | Not a holder of this film | Treat as page not found |
| `NOT_FOUND` | 404 | | "This page doesn't exist. It may have been deleted." |
| `INVITE_NOT_FOUND` | 404 | | Under the invite code field: "Can't find this invite code. Check for typos." |
| `INVITE_EXPIRED` | 410 | | "This invite code has expired. Ask an administrator for a new one." |
| `INVITE_USED` | 410 | | "This invite code has already been used." |
| `RESET_INVALID` | 410 | The reset link expired or was used | Ask them to have an administrator generate one again |
| `USERNAME_TAKEN` | 409 | | Under the username field: "This username is taken." |
| `LAST_ADMIN` | 409 | Would leave the system without an administrator | Explain that at least one administrator must remain |
| `STORAGE_LIMIT` | 409 | Over the storage limit | Next to the button, explain how much is needed, how much is left, and the shortfall, with "Go to Storage" |
| `DISK_FULL` | 507 | The disk itself is out of space (the limit hasn't been reached) | Same as above, and also explain that this is a disk problem for an administrator to handle |
| `TORRENT_STATE` | 409 | This action can't be done in this state; or this version is being deleted | Refresh that row; usually no message needed. When hit while downloading: "This version is being deleted. Try again in a moment." |
| `MEDIA_NOT_READY` | 409 | The download isn't finished; or the analysis data needed isn't there yet (still analyzing, or analysis failed) | Show progress, "try again later", or explain that analysis failed and offer "Analyze again" |
| `SUBTITLE_DUPLICATE` | 409 | Subtitles with the same content were already added | "These subtitles have already been added." |
| `REVISION_CONFLICT` | 409 | Someone else saved first | See "Two people editing at once" in [09-sync-workbench.md](09-sync-workbench.md) |
| `LLM_NOT_CONFIGURED` | 409 | No enabled LLM profile | The translation window says "An administrator hasn't set up a language model"; administrators get an extra link to LLM settings |
| `TRANSLATION_RUNNING` | 409 | The same translation is already running | Explained in the translation window |
| `YTS_NOT_CONFIGURED` | 409 | The YTS URL isn't set yet | Guidance on the Search page, see [11-pages.md](11-pages.md) |
| `UPLOAD_TOO_LARGE` | 413 | | Explain the limit |
| `UNSUPPORTED_FILE` | 415 | | "This file type isn't supported. Upload .srt, .ass or .vtt, or a .zip, .rar or .7z archive." |
| `VALIDATION` | 422 | Invalid field | Show under each field, and move focus to the first wrong field |
| `WRONG_PASSWORD` | 422 | The current password is wrong when changing the password | "The current password is wrong." |
| `HASH_NOT_FROM_YTS` | 422 | The info hash isn't in that film's list of versions | Doesn't happen in normal use. Refresh the film page |
| `TORRENT_INVALID` | 422 | The magnet link or .torrent file added by hand can't be used; `details.reason`: `BAD_MAGNET`, `BAD_TORRENT`, `NO_VIDEO_FILE`, `UNSAFE_PATH`, `NO_METADATA` | Explain the reason in the window |
| `TMDB_NOT_CONFIGURED` | 409 | Adding by hand needs a TMDB film to be chosen, but there is no TMDB key | Ask an administrator to set it in "Sources" |
| `TMDB_UNREACHABLE` | 502 | Can't reach TMDB | Try again later |
| `CANDIDATE_UNAVAILABLE` | 422 | A candidate subtitle's file couldn't be fetched or read | Explain according to `details.reason`, see [11-pages.md](11-pages.md) |
| `NO_CONFIRMED_SUBTITLE` | 422 | No subtitles chosen when exporting, or unconfirmed ones chosen | "Pick at least one confirmed subtitle. If there aren't any, sync first." |
| `INVALID_FILENAME` | 422 | | Explain the rules under the file name field |
| `SETTING_INVALID` | 422 | | Show under the matching field |
| `RATE_LIMITED` | 429 | Too many sign-in attempts | Explain how long to wait |
| `ALIGN_FAILED` | 500 | Both auto-align methods failed, or it timed out | Message bar: "Auto-align didn't work. Try again, or align by hand with anchors." |
| `YTS_UNREACHABLE` | 502 | Can't reach YTS | The Search page's error state, see [11-pages.md](11-pages.md) |
| `YTS_BAD_RESPONSE` | 502 | YTS returned something that can't be understood (quite possibly an impostor site) | Same as above, plus a reminder to check the URL |
| `INTERNAL` | 500 | Unexpected error | "Something went wrong. Try again." The log must have the full details |

Failures that don't become HTTP errors:

- Failures of individual sources during subtitle search are written in that source's `ProviderStatus.error`; other sources return as usual.
- Failures fetching a candidate subtitle's file are written in `Candidate.fetchError`.
- Failures of analysis and preview assets are written in `MediaStatus.errors` (one slot per asset).
- Download failures are written in `Torrent.error`.
- The result of testing a source on the admin page is written in the response's `ok` and `code`.
