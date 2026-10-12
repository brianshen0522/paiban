# 13 Settings

What administrators adjust in the interface is stored in the `settings` table (one row per item); keys are stored in `secrets`. Things decided at deployment are environment variables, see [02-architecture.md](02-architecture.md).

The API shapes are `Settings` and `SettingsInfo` in `packages/shared/src/contracts/api.ts`. `PATCH /api/admin/settings` sends only the parts to change; if any item is invalid, the whole request is rejected with `SETTING_INVALID`, and `details.fields` says which item and why. Each successful change writes one `admin.settings.change` entry (recording which keys changed, not the content of keys).

The storage limit is also stored in the `settings` table, but it isn't in the `Settings` type: it has its own endpoint and validation (`PUT /api/admin/storage/limit`), and the current value is in `Usage.limitBytes`.

## Settings items

| Key | Type | Default | Rules | On which page |
| --- | --- | --- | --- | --- |
| `storage.limitBytes` | integer | Written once from `STORAGE_LIMIT_GB` | See [10-storage.md](10-storage.md). Uses the dedicated endpoint `PUT /api/admin/storage/limit` | Storage management |
| `downloads.maxActive` | integer | 2 | 1 to 5 | Download settings |
| `downloads.maxPerUser` | integer | 2 | 1 to 5, not greater than `maxActive` | Download settings |
| `downloads.downloadLimitKB` | integer | 0 | 0 to 1,000,000. 0 means no limit. Unit is KB (1024 bytes) per second | Download settings |
| `downloads.uploadLimitKB` | integer | 512 | Same as above | Download settings |
| `downloads.seedMode` | `stop` / `ratio` | `stop` | | Download settings |
| `downloads.stallMinutes` | integer | 30 | 5 to 240 | Download settings (D37) |
| `downloads.trackers` | string array | See [05-yts.md](05-yts.md) | Each item is a URL starting with `udp://`, `http://` or `https://`; at most 20 items; may be empty | Download settings (D37) |
| `media.analyzeAuto` | boolean | true | | Download settings |
| `media.proxyAuto` | boolean | true | | Download settings |
| `media.proxyResolution` | `480p` / `720p` | `480p` | | Download settings |
| `yts.baseUrl` | string | empty | Starts with `https://`, only a host and an optional port, no path; trailing slash removed on save; can't point to an internal address. In development and testing (`ALLOW_LOCAL_SOURCES=1`) it may be `http://` and an internal address | Sources |
| `providers.cacheHours` | integer | 24 | 1 to 168 | Sources |
| `providers.justsubtitles.enabled` | boolean | true | | Sources |
| `providers.justsubtitles.mode` | `direct` / `subdl` | `direct` | Switching to `subdl` without a SubDL key is allowed, but show the warning "Switched, but there is no SubDL key yet, so lookups will fail." | Sources |
| `providers.yify.enabled` | boolean | true | | Sources |
| `providers.yify.baseUrl` | string | `https://yts-subs.com` | Same rules as `yts.baseUrl` | Sources |
| `providers.assrt.enabled` | boolean | true | | Sources |
| `providers.zimuku.enabled` | boolean | true | | Sources |
| `providers.zimuku.searchUrl` | string | empty | Empty, or starting with `https://` and containing `{q}` | Sources (the prototype has no such field) |
| `subtitles.defaultLangs` | language array | `zh-Hant`, `en` | At least one | "Shared settings" on Sources. The prototype only displays it and can't change it; the real version makes it checkable |
| `align.asr` | boolean | true | Whether films analyzed from now on get speech recognition ("Speech recognition" in [08-media-pipeline.md](08-media-pipeline.md)). Turning it off doesn't affect what's already done | "Auto-align" on Sources (new) |
| `llm.translatePerHour` | integer | 5 | 0 to 100. The maximum number of subtitle translations each person can start per hour ([18-llm.md](18-llm.md)); 0 means no new translations can be started | LLM settings page (new) |

### Error messages in the interface

| Situation | Text |
| --- | --- |
| `maxActive` or `maxPerUser` out of range | Enter a whole number from 1 to 5. |
| `maxPerUser` greater than `maxActive` | Can't be greater than the site-wide limit (2). |
| Speed limit not a whole number of 0 or more | Enter a whole number of 0 or more; 0 means no limit. |
| `stallMinutes` out of range | Enter a whole number from 5 to 240. (new) |
| Invalid tracker format | Line 3 isn't a valid tracker address. (new) |
| Invalid URL format | Enter a full address starting with https://, e.g. https://yts.example. (The example at the end changes per field: the YIFY Subtitles field uses https://yts-subs.com; the Zimuku field gives no example. `yts.example` is a domain reserved for illustration; it appears only in this help sentence and is never taken as a default) |
| URL points to an internal address | This address points to an internal network and can't be used. (new) |
| `cacheHours` out of range | Enter a whole number from 1 to 168. |
| Zimuku URL has no `{q}` | The address must contain {q}, which becomes the film title when searching. (new) |
| OpenAI-compatible chosen but no URL or model filled in (`REQUIRED`) | Required for OpenAI-compatible services. (new) |
| Invalid model service URL format | Enter a full address starting with http:// or https://, e.g. https://dashscope.aliyuncs.com/compatible-mode/v1. (new) |

Entries marked "(new)" are fields or checks the prototype doesn't have; write their sentences in the same tone.

## Keys

| Name | Purpose | When not set |
| --- | --- | --- |
| `tmdbKey` | Chinese titles, Chinese synopses, posters and ratings on Search and the film page (Brian, 2026-10-06); turning IMDb IDs into TMDB IDs (JustSubtitles needs this); the Chinese title used for Assrt searches | Titles and synopses are YTS's English ones, posters are YTS's, and the rating is the IMDb rating YTS provides (labeled "IMDb"); JustSubtitles falls back to title matching (may not find a match); Assrt searches by English title only |
| `subdlKey` | JustSubtitles' fallback mode | Fallback mode can't be used |
| `assrtToken` | Assrt (Shooter) | This source shows "Not set"; other sources are unaffected |

Language model keys are not here: each LLM profile has its own key, stored in `llm_profiles` ([18-llm.md](18-llm.md)). The former `llmKey` and `align.llm.*` were moved into the first profile during upgrade and then deleted.

`PUT /api/admin/secrets/:name` writes and `DELETE` clears. The input is a password field; when already set it shows "Set. Leave empty to keep it"; after saving it says "〈name〉 saved. Its content won't be shown again." Pressing save with the field empty gives "No new value entered. Kept the current setting."

Help text on how to get each one:

- TMDB: "Get one for free in your TMDB account settings."
- SubDL: "Only used when the official SubDL API is selected."
- Assrt: "Sign up at Assrt (Shooter) and get it from your user panel."
- Language model: "For Claude, apply at console.anthropic.com; for Qwen (通義千問), apply at Alibaba Cloud Model Studio (DashScope). Only used when the subtitles and the film's spoken language differ; each auto-align uses about a dozen or so requests."

## Read-only information (`SettingsInfo`)

| Item | Source | Shown in |
| --- | --- | --- |
| Which keys are set | Whether `secrets` has that row | Sources |
| Incoming ports | Environment variables `TORRENT_PORT`, `TORRENT_DHT_PORT` | "Connection" in Download settings (D31). Help text: "These two ports are set in the deployment configuration. Open them in both Docker and the router: 〈port〉 (TCP and UDP), 〈DHT port〉 (UDP). Downloads still work without them, just more slowly." (new: in the prototype this is an editable field) |
| Incoming connections | The `torrent` heartbeat | Same as above (D32): "Incoming connections seen in the last 24 hours" or "No incoming connections seen yet" (new: in the prototype this is a test button) |
| Disk | Free space on `/data`, system reserve, maximum limit | Storage management, System status |

## Test connection

`POST /api/admin/sources/:id/test`, where `:id` is `yts`, `tmdb`, `justsubtitles`, `subdl`, `yify` or `assrt`. What each source actually does is in [05-yts.md](05-yts.md) and [07-subtitle-providers.md](07-subtitle-providers.md).

This endpoint always returns 200, with a `SourceCheck` body: `{ok, code, data, ms}`. **It returns no sentences**; the text next to the button is written by the front end from `code` and `data`. The test result also updates that source's status (`SourceHealth`, which the Overview page reads). Between pressing the button and the result coming back, the text next to the button reads "Testing…".

| `code` | Text | `data` used |
| --- | --- | --- |
| `OK` (YTS) | Responded 200 · 0.4 s | `status`; the seconds come from `ms` |
| `OK` (TMDB) | Key is valid | |
| `OK` (JustSubtitles, SubDL) | 30 results in English | `count` |
| `OK` (YIFY Subtitles) | Pages can be parsed | `rows` |
| `OK` (Assrt) | Quota OK | `quota` |
| `NOT_CONFIGURED` | No address set yet. / No key set yet. | |
| `INVALID_KEY` | The key is invalid. | |
| `UNREACHABLE` | Can't connect. (When the prototype simulates YTS being unreachable it says "Connection timed out"; the real version can't tell a timeout from other reasons for being unreachable, so it uses this one sentence for all) | `status` (if any) |
| `BAD_RESPONSE` | The reply is in the wrong format. The source may have changed, or the address no longer points to it. | |
| `REDIRECTED` | This domain redirects requests to yts.example. Once you've confirmed that's the real one, change the setting to it. | `host` |
| `RATE_LIMITED` | Usage limit reached. Try again later. | `retryAfterSeconds` (if any) |

The five `OK` sentences are the prototype's wording; the rest are new.

## When settings take effect

| Setting | Takes effect |
| --- | --- |
| Storage limit | Immediately. The next admission uses the new value |
| Simultaneous downloads | `torrent`'s next round (within 2 seconds). **Lowering it doesn't pause downloads already running**; it just doesn't start new ones until the count drops |
| Speed limits | `torrent`'s next round |
| Seeding mode | Downloads that finish afterwards. Ones currently seeding are handled per the new setting on the next round |
| Stall timeout, trackers | Downloads started afterwards |
| Automatic analysis | Downloads that finish afterwards. Analyses already queued proceed as before |
| Automatic preview files, resolution | Downloads **admitted** afterwards (D40). Ones already downloading or finished follow the settings in force when they were admitted; existing preview files are left alone. Pressing "Make preview file" in the workbench later uses the resolution in effect at that moment |
| YTS URL, per-source settings | Immediately |
| Cache time | Cache entries written afterwards |

`api` may cache settings for a few seconds when reading them; `torrent` rereads them every round; `media` rereads them at the start of each job.

## Personal preferences

Stored in `users.prefs`, not site-wide settings. The prototype's Profile page can change these preferences, but only "Convert Simplified Chinese subtitles to Traditional automatically" is actually wired to behavior; the real version wires up all four per the "Description" column.

| Key | Default | Description |
| --- | --- | --- |
| `langs` | `subtitles.defaultLangs` at the time the account was created | The language toggle buttons on the Subtitles tab select these by default. At least one |
| `convertToTraditional` | true | Automatically convert Simplified subtitles to Traditional when adding (used when `POST /api/candidates/:id/add` doesn't include `convertToTraditional`) |
| `secondLine` | false | The Sync tab has "Also show" on by default; English subtitles are chosen if there are any, otherwise another one |
| `quality` | `1080p` | In the film page's version table, rows of this quality get a mark. "Only highlighted in the version list; nothing downloads automatically." |
| `posterRegion` | `null` | Which country's version of film posters to use: `TW`, `HK`, `CN`, `US`, `JP`, `KR`; `null` follows the interface language (Taiwan for Chinese, US for English) (Brian, 2026-10-10) |
| `locale` | `null` | Interface language: `'zh-TW'`, `'en'`; `null` follows the browser (Brian, 2026-10-08). Also decides which language is used for the names of AI translation subtitles this person makes and for the subtitle track titles in exports |

## Constants that can't be configured

Kept in one file in `packages/shared`, managed in one place, with comments; opening them up can be decided later.

| Constant | Value | Source |
| --- | --- | --- |
| Site name | 拍板 / Paiban | D9. **The user-visible site name lives only here**; the `User-Agent` of outbound requests (`Paiban/<version>`) is also built from this constant |
| Search results per page | 24 | [05-yts.md](05-yts.md) |
| Number of checkpoints | 8 | [09-sync-workbench.md](09-sync-workbench.md) |
| Auto-align search range | 60 seconds | [08-media-pipeline.md](08-media-pipeline.md) |
| Score color thresholds | Whole film 0.70 / 0.55; single line 0.50 / 0.25 | Same as above; not yet calibrated |
| Upload size limit | 20 MB | [07-subtitle-providers.md](07-subtitle-providers.md) |
| Extraction limits | 200 entries, 50 MB total, 10 MB per file | Same as above |
| Maximum candidates per ranking | 30 | Same as above |
| Interval between source requests | JustSubtitles (including SubDL), YIFY Subtitles 1 second; Assrt 3.4 seconds | Same as above |
| Maximum wait for the fetch when "Add" is pressed | 30 seconds | Same as above |
| Auto-align timeouts | ffsubsync 20 seconds per run; the endpoint waits at most 60 seconds | [08-media-pipeline.md](08-media-pipeline.md) |
| Automatic retries after a background job fails | 1 (2 runs in total) | Same as above |
| How long a candidate can stay "Processing" before it counts as failed | 10 minutes | Same as above ("Reconciliation") |
| Reconciliation interval | 60 seconds | [02-architecture.md](02-architecture.md) |
| How much larger than YTS's listed size a torrent may be without a separate space check | 64 MB | [06-torrent-worker.md](06-torrent-worker.md) |
| Maximum export file name length | 200 characters | [11-pages.md](11-pages.md) |
| Bitrate for the preview reservation | See [10-storage.md](10-storage.md) | |
| Export reservation | Original file × 1.01 + 1 MB | [10-storage.md](10-storage.md) |
| Usage indicator thresholds | Yellow at 2 GB left, red at 0.5 GB | Prototype |
| Overview's "Disk almost full" (`DISK_LOW`) | Free disk space below twice the system reserve | Set on 2026-10-06 (docs/changes.md) |
| Session lifetime | 30 days | [12-auth.md](12-auth.md) |
| Invite link lifetime options | 1, 3, 7 days | Prototype |
| Reset link lifetime | 30 minutes | Prototype |
| Autosave delay | 1.5 seconds | [09-sync-workbench.md](09-sync-workbench.md) |
| Undo steps | 100 | Prototype |
