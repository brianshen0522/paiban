# 00 Settled decisions

This document has the highest authority. When other documents, the prototypes or the reference code conflict with it, this one wins, and the conflict is recorded in `docs/agent-notes.md`.

Every entry is marked with its source, because the source decides whether it can be changed:

| Source | Meaning | Can it change? |
| --- | --- | --- |
| **Specified** | Brian said it explicitly | No. If in doubt, ask him |
| **Decided for Brian** | Decided after Brian said "you decide" | Not on your own; you can give reasons and ask him to decide again |
| **Assumption** | Proposed during planning; Brian saw it and didn't object | If it turns out not to work, propose an alternative and wait for his confirmation |
| **Handover** | Added only when packing this handover pack; Brian hasn't seen it | You may adopt a better approach directly, but say clearly in the report what changed and why |

## Features and scope

| # | Decision | Source |
| --- | --- | --- |
| D1 | Main flow: search YTS → list every version of the film → download with the built-in torrent client → find subtitles on subtitle sites → sync the subtitles in the browser → confirm → the back end packs the video and subtitles into an MKV → download | Specified |
| D2 | The users are Brian himself, family and friends. Registration is not open to the public | Specified |
| D3 | Technology: Docker, Node.js, React, PostgreSQL | Specified |
| D4 | Torrent engine: WebTorrent embedded in Node; no separate program such as qBittorrent | Specified |
| D5 | Subtitle sources: JustSubtitles, YIFY Subtitles, Chinese subtitle sites. **All done together in the same phase, with JustSubtitles the most important**; it can't be pushed to later | Specified |
| D6 | Subtitle sync is "auto-align + manual fine-tuning". **All sync operations happen in the browser**, the features are complete, and users never have to open other software | Specified |
| D7 | **No periodic deletion, and no automatic deletion of any kind.** An administrator sets a storage limit; once it's reached, no new films can be loaded; files have to be deleted by hand before downloading again | Specified |
| D8 | Exported MKVs also count toward the storage limit; without enough space, you can't export | Decided for Brian |
| D9 | The platform is named "拍板" (Paiban). The site name users see may appear only in one configuration constant, so it's easy to rename later. Technical identifiers (cookie names, request headers, database notification channels, package names) may use `paiban` directly | Decided for Brian |
| D10 | Approach for the Chinese subtitle sites: Assrt (Shooter) goes through its official API; Zimuku has a CAPTCHA, so it's only "assisted": the system opens its search page, and the user downloads the file and drags it in | Assumption |
| D11 | Subtitles are packed as soft subtitles (subtitle tracks in the MKV). Video and audio are copied directly, not re-encoded, and subtitles are not burned into the picture | Assumption |
| D12 | Syncing can start only after a film has finished downloading. Playing while downloading is left for later | Assumption |
| D13 | The interface is in Traditional Chinese (Taiwan usage) and English, each person's choice (since 2026-10-08, Brian). Code, identifiers, commit messages and, since 2026-10-12, the documents are in English | Specified (Brian, 2026-10-08 and 2026-10-12) |
| D14 | Deployed on a home server or NAS, single-machine Docker Compose | Assumption |

## Accounts and permissions

| # | Decision | Source |
| --- | --- | --- |
| D15 | Invite-only: an administrator generates a one-time invite link, and only whoever gets it can register | Assumption |
| D16 | Two roles: administrator, member. Only administrators can enter the admin pages | Assumption |
| D17 | For a forgotten password, an administrator generates a one-time reset link; no email is sent | Assumption |
| D18 | The first administrator is created from environment variables (only takes effect when the database has no users at all); there is no public setup page | Handover |

## Storage

The full rules are in [10-storage.md](10-storage.md).

| # | Decision | Source |
| --- | --- | --- |
| D19 | There is only one site-wide storage limit, no per-person quotas | Assumption |
| D20 | As soon as a download is admitted, it takes up its full size. You never find out halfway through a download that it won't fit | Assumption |
| D21 | The same torrent (same info hash) is stored only once site-wide. When a second person wants the same version, it's "Add to my library" and takes no extra space; files are deleted only when every holder has removed it | Assumption |
| D22 | Lowering the limit below current usage is allowed: no files are deleted, but until usage drops below the limit, nobody can download or export | Assumption |
| D23 | Administrators can force delete any file of anyone's | Assumption |
| D24 | Versions browsers can't play directly (x265, 10-bit) need a preview file. Space for the preview file is reserved together with the download when it's admitted, so usage isn't pushed over the limit only after the download finishes | Assumption (a gap found while building the prototype) |
| D25 | The reserved size is estimated from the transcoding bitrate cap; once done, the actual size is recorded instead, and the excess is freed automatically. The preview assets include an audio file `audio.m4a`, so users can start syncing subtitles by sound while the picture is still being transcoded | Handover |

## Safety and boundaries

| # | Decision | Source |
| --- | --- | --- |
| D26 | Torrents come from YTS search results, or from a signed-in person pasting a magnet link or uploading a .torrent file in the "Add a torrent by hand" window (since 2026-10-09; originally only YTS was accepted). For one added by hand, a film on TMDB must be picked first, and only the largest video file is downloaded | Specified (Brian, 2026-10-09) |
| D27 | **Design and implement no way of bypassing CAPTCHAs or anti-scraping mechanisms.** When a source blocks automated access, it becomes assisted or is disabled | Assumption |
| D28 | **Do not use, store or log any API key that doesn't belong to the user.** For example, JustSubtitles responses sometimes carry an `api_key` in URLs; it is always removed while parsing and must never be stored in the database or written to logs | Assumption |
| D29 | Development and testing download no copyrighted videos. Automated tests use only the synthetic material in `fixtures/`, the simulated YTS, and the local torrent tests (`reference/torrent/`), and don't use subtitles downloaded from real sources. The only exceptions are the two **manual** source checks (phase 0 item 4, and the manual acceptance in phase 5): for each source, the minimum number of subtitle archives may be downloaded, only to confirm the format; they aren't committed and aren't used as test fixtures | Assumption |
| D30 | The web page itself sends no requests to YTS or subtitle sites. Posters, search and subtitles are all fetched by the server on its behalf. External links the user clicks (a subtitle's source page, Zimuku's search page) are exempt, and always open in a new tab | Handover |

## Designs added at handover

These were settled only when the plan was written up as an implementable spec; the prototypes don't have them or do them differently. Details are in the respective documents.

| # | Decision | Difference from the prototype |
| --- | --- | --- |
| D31 | The BitTorrent incoming port is set by an environment variable; the interface only shows it and can't change it | The prototype's "Download settings" can change it. The port Docker exposes is written in compose, so changing it in the web page wouldn't take effect |
| D32 | Incoming connections are shown by passive observation (whether anything outside has connected in recently) | The prototype has a "Test whether outside peers can connect" button, which would need a third-party service |
| D33 | Auto-align uses two methods at once (ffsubsync and this project's sync core), takes the one with the higher score, and tells the user whether the two agree | The prototype uses only the sync core. See [08-media-pipeline.md](08-media-pipeline.md) |
| D34 | Subtitles are always converted to a plain-text list of lines for syncing and export. ASS styles and effects are dropped in the first version; "Keep ASS styles" is listed as a later feature | The prototype only demonstrates SRT |
| D35 | "Bilingual" means showing another subtitle track of the same film alongside for reference, not each line carrying two languages | The prototype's demo data has two lines, Chinese and English, for every cue |
| D36 | 8 checkpoints by default | The prototype uses 5, because the demo clip is only 92 seconds |
| D37 | Two new settings: the tracker list, and how long a download can stall before it counts as failed | The prototype doesn't have them |
| D38 | When no TMDB key is set, JustSubtitles uses its own title search to find the ID instead (adopted only when both title and year match) | The prototype assumes the key always exists |
| D39 | The preview file reservation is larger than the prototype shows (the prototype uses a typical size, production uses the cap) | See D25 |
| D40 | Whether to make a preview file, and at what resolution, is decided the moment a download is admitted and travels with that download. Changing the settings later affects only downloads admitted afterwards | The prototype doesn't have this problem (its preview files are fake). This way the reserved space and the actual work match up; see [10-storage.md](10-storage.md) |
| D41 | Requests to sources such as Assrt (Shooter) and JustSubtitles, no matter which program sends them, all go through the same queue (one table in the database), which guarantees the spacing | The prototype makes no outbound requests |

## What we won't do

Explicitly not in the first version, unless Brian raises it:

- TV series (YTS only has films)
- Burning subtitles into the picture; transcoding to other formats or resolutions for download
- Playing while downloading
- Public registration, email notifications, third-party sign-in
- Multiple hosts, clusters
- A mobile app (the web page has to work on phones)
- Automatic downloads, subscriptions, RSS
- Scheduled clean-up of any kind
