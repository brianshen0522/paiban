# 11 Pages and flows

**The prototype is the other half of this document.** Open `prototype/platform/index.html` in a browser and you can use it: every page, every state and every line of copy is in there. This document explains where each page's data comes from, which states it has, which parts of the prototype are fake, and where production differs from the prototype.

- Screens: `prototype/platform/screenshots/` (numbers match the table below)
- Source for the copy and layout: `prototype/platform/src/app2.js` (regular pages), `app3.js` (admin pages), `app4.js` (actions and toasts), `app.css`
- The prototype's automated checks: `prototype/platform/e2e.cjs`, 72 of them. Production must have every behavior they describe; the few that are tied to demo data or to switches only the prototype has need a different approach, listed at the end of this document in "Carrying over the prototype's checks"

The prototype uses old public-domain films as demo data; search, downloads, subtitle search and export are all simulated (download progress is an animation sped up 10 times). The Sync tab really works.

A few things to know while reading this document:

- **Sentences quoted in this document come from the prototype unless marked otherwise.** Sentences marked "(new)" are not in the prototype and must be added in production; don't look for them in the prototype.
- **Sizes in the prototype are round numbers for the demo** (1.9 GB, 300 MB). Production computes them from bytes and displays them by the rules in [17-ui.md](17-ui.md), so the numbers won't match the screenshots exactly.
- **The prototype's personal preferences aren't wired to any behavior**: changing the language, quality or second-language preference doesn't change other pages. Production must wire them up ("Personal preferences" in [13-settings.md](13-settings.md)).
- Where the two disagree, this document wins.

## Routes

| Route | Page | Who | Screenshot |
| --- | --- | --- | --- |
| `/login` | Sign in | Signed out | 01 |
| `/invite/:code?` | Register with an invite code | Signed out | 24 |
| `/reset/:token` | Reset password | Signed out | Not in the prototype |
| `/search` | Search (home page after sign-in) | Everyone | 02, 18, 32 |
| `/movies/:ytsId` | Film page | Everyone | 03, 04 |
| `/downloads` | Downloads | Everyone | 05, 34 |
| `/library` | Library | Everyone | 06, 25, 30 |
| `/library/:torrentId/subtitles` | Workspace: Subtitles | Holders | 07, 08, 31 |
| `/library/:torrentId/sync/:subtitleId?` | Workspace: Sync | Holders | 09 |
| `/library/:torrentId/export` | Workspace: Export | Holders | 10, 11 |
| `/storage` | Storage | Everyone | 12 |
| `/profile` | Profile | Everyone | 13 |
| `/admin` | Overview | Administrators | 14 |
| `/admin/users` | Users & invites | Administrators | 15 |
| `/admin/storage` | Storage management | Administrators | 16, 33 |
| `/admin/sources` | Sources | Administrators | 17 |
| `/admin/downloads` | Download settings | Administrators | 19 |
| `/admin/system` | System status | Administrators | 20 |
| `/admin/audit` | Activity log | Administrators | 21 |

When not signed in, every page redirects to `/login`, and after signing in you return to where you were going (the prototype always returns to Search; "returning to where you were" is added in production). A member opening `/admin/…` sees "Only administrators can see this page." A route that doesn't exist, or the workspace of a film you don't hold (administrators included), shows "This page doesn't exist. It may have been deleted."

## Shell

Shared by every page after sign-in (screenshots 22, 23).

- **Top bar**: brand (click to return to Search), site-wide search box, usage indicator, notifications, account menu.
- **Side menu**: Search, Downloads, Library, Storage, Profile; administrators get an extra "Admin" group. The number next to "Downloads" counts your own queued, downloading and paused downloads. (The prototype also counts analyzing ones; in production a film being analyzed is already in the library, so it doesn't count.)
- **Usage indicator**: rules are in [10-storage.md](10-storage.md).
- **Notifications**: the button shows the unread count. Opening it shows the latest few, with unread ones marked; clicking one goes to the related page and marks it read. "Mark all as read". When the target no longer exists (the film was deleted), it goes to the Library instead; export notifications go to the Storage page instead (see "Notifications" in this document).
- **Appearance button**: an icon button on the right of the top bar, left of "Notifications"; each press switches to the next appearance (see [17-ui.md](17-ui.md)).
- **Interface language button** (Brian, 2026-10-08): a round button left of the appearance button, showing the language it switches to ("EN" when in 繁體中文, "中" when in English). One press switches, and it is saved in the account's preferences (`prefs.locale`). The sign-in, registration and reset-password pages also have it in the top right corner, next to the appearance button; there nobody is signed in yet, so it is only remembered in this browser.
- **Account menu**: name and role, Profile, Sign out.
- **Toasts**: bottom right, at most 3 at a time, disappearing after about 5 seconds, optionally with one action button ("View downloads", "Open", "Go to Export"). They are only for **confirming an action that just finished**; errors and things the user has to decide go on the page, not in a toast. In a few places the prototype takes the shortcut of showing a refusal or validation error as a toast; production moves those onto the page, see the table below.
- At phone width the side menu collapses into a row at the top (see screenshots 32 to 34).
- Esc closes pop-up menus and confirmation dialogs.

**Confirmation dialog style** (Brian, changed 2026-10-06): destructive actions don't use the browser's dialogs. After pressing "Remove", a small dialog appears in the center of the screen (`<dialog>`, with the background dimmed), with a red strip along the top, holding an explanation and two buttons (a gray "Not now" on the left, the red confirm button on the right). It used to expand in place, which stretched that card or row, so it was changed. Focus starts on "Not now", so pressing Enter can't delete by accident; Esc or clicking outside the dialog cancels; after it closes, focus returns to the original button. Both buttons are disabled while confirming. The explanation must spell out the consequences; see each page.

**Messages the prototype shows as toasts and production puts on the page**:

| Prototype toast | Where it goes in production |
| --- | --- |
| "Not enough space to export." | The space note on the Export tab already turns red; "Start export" is simply disabled instead of waiting for a press |
| "Not enough space to retry. Delete files you don't need in Storage first." | An explanation expanded under that row on the Downloads page (how much is needed, how much is left, how much is short) with "Go to Storage", the same as when the film page is blocked |
| "This file type isn't supported. Upload .srt, .ass or .vtt, or a .zip, .rar or .7z archive." | Error message under the upload area |
| "Couldn't read this file. Try again." | When the upload itself fails (network), under the upload area; when the file arrived but can't be read, it is a failed candidate row in the candidate list (see "Subtitles") |
| "The display name must be 1 to 20 characters." | Under the display name field |
| "Enter a full address starting with https://." | Under that address field, using the full sentence from [13-settings.md](13-settings.md) |
| "Pick at least one language." / "Keep at least one language." | Under the language toggle buttons |
| "Pick at least one confirmed subtitle. If there aren't any, sync first." | Under the subtitle track list |
| "No confirmed subtitles yet. Confirm one in 'Sync' first." (on pressing the disabled "Start export") | Not needed: the button really is disabled, and the reason is already written in the subtitle track section |
| "All automatic sources are disabled." | Next to the "Search all sources" button, which is disabled |

"Copied." and, when copying fails, "Can't copy automatically here. Select the text by hand." stay toasts as in the prototype; no need to move them.

## Sign in (01)

Username, password, sign-in button. Two lines below: "Got an invite link? Register with the invite code" and "Forgot your password? Ask an administrator for a one-time reset link."

There is a single line of error message, between the password field and the sign-in button (`role="alert"`).

| Situation | Message |
| --- | --- |
| No username | Enter your username. |
| No password | Enter your password. |
| Wrong credentials | Wrong username or password. |
| Account disabled | This account has been disabled. Contact an administrator. |
| Too many attempts | Too many attempts. Try again in n minutes. (new) |

Don't build the "Prototype shortcuts" block at the bottom of the prototype. The sign-in, registration and reset-password pages have the appearance button in the top right corner (it can be switched before signing in).

## Register with an invite code (24)

Fields: invite code (filled in from the link), display name, username, password, password again. Each field has a help line underneath, replaced by the error message when there is an error, and focus moves to the first field with an error.

| Field | Rule | Error message |
| --- | --- | --- |
| Invite code | Exists, not expired, not used | Can't find this invite code. Check for typos. / This invite code has expired. Ask an administrator for a new one. / This invite code has already been used. |
| Display name | 1 to 20 characters | Enter a display name. / The display name can be at most 20 characters. |
| Username | Letters, digits, underscores, 3 to 32 characters; case-insensitive; must be unique | The username must be letters, digits or underscores, at least 3 characters. / The username can be at most 32 characters. (new; the prototype has no upper limit) / This username is taken. |
| Password | At least 8 characters | The password must be at least 8 characters. |
| Password again | Same as the password | The passwords don't match. |

On success you are signed in directly and taken to Search, with the toast "Welcome, 〈name〉. Try searching for a film first."

## Reset password

The prototype doesn't have this page; all the sentences below are new. The layout is the same as the registration page: the username (read-only), new password, and the new password again. Password rules and messages are the same as on the registration page ("The password must be at least 8 characters." "The passwords don't match."). When the link is invalid or expired it shows "This link no longer works. Ask an administrator for a new one." On success it goes to the sign-in page with the toast "Your password has been reset. Sign in with the new one."

## Search (02, 18, 32)

Data: `GET /api/yts/movies`.

- While typing in the search box, matching films on TMDB are listed underneath (Chinese titles can be found too); clicking one opens the same film on YTS directly. Details are in "Finding films by Chinese title (Brian, 2026-10-06)" in [05-yts.md](05-yts.md). The list is an ARIA combobox: up and down arrow keys select, Enter opens the selected one, Esc closes it; with nothing selected, Enter searches as before. The line under the list says "Press Enter to search YTS for "…" (English titles only)".
- The search box and four filters: quality (All, 720p, 1080p, 2160p), genre, rating (Any, 6, 7, 8 and up), sort (Recently added, Rating, Year, Seeds).
- Placeholder text in the search boxes: the top bar's is "Search films, e.g. charade"; for the one on the Search page the prototype says "Title or year, e.g. charade, 大都會 (Metropolis), 1963", and production drops the Chinese-title example: "Title or year, e.g. charade, 1963" (new).
- Without a keyword the heading is "Recently added"; with one it is "Results for "charade"", with the count next to it.
- Each card: poster, title (when TMDB has a Chinese title, the Chinese is on top and the English title on a second line), year, rating (preceded by its source, "TMDB" or "IMDb"), available qualities, and your own status ("In Library", "Downloading"). The "Rating" used for filtering and sorting is YTS's IMDb rating: YTS can only filter by that, and TMDB ratings can't be used to filter the whole catalog.
- The page header's note: the prototype says "Titles come from YTS, mostly in English; Chinese titles and years work too." The prototype's demo data carries its own Chinese titles, so they are searchable; the real YTS only knows English titles. **Production doesn't do Chinese-title search**, so this sentence becomes "Titles come from YTS. Search by English title or year." (new) The "search by Chinese title" item in the prototype's automated checks therefore doesn't apply.
- The Chinese title on a card only appears once a TMDB key is set and someone has searched subtitles for that film: looking up TMDB is part of the subtitle search ([07-subtitle-providers.md](07-subtitle-providers.md)), and the Chinese title found is stored in that film's record. Without it that line isn't shown.

| State | Screen |
| --- | --- |
| Loading | Six gray placeholder cards |
| No results | With a keyword: "Nothing found for "…"." Without a keyword (filters only): "No films match these filters." Both are followed by "YTS titles are in English. Try the English title, the year, or fewer filters." and "Clear search and filters" |
| Can't reach YTS (18) | A red explanation: "Can't reach YTS. Its domain changes often and may have changed again." Administrators see "Update the address in Sources, then try again." and a button to go there; members see "Ask an administrator to update the address in Sources." Both get "Try again" |
| YTS's reply can't be understood (`YTS_BAD_RESPONSE`) | Same layout as above, with the first sentence replaced by "This address doesn't return YTS data. It may not be YTS anymore." (new) |
| YTS address not set yet (`YTS_NOT_CONFIGURED`) | Not in the prototype; the sentences are new. Administrators: "The YTS address is not set yet." plus a button to go to Sources; members: "An administrator hasn't finished setting things up." |

**Pagination**: the prototype only has 14 films and no pagination. Production shows 24 films per page, with "Previous / Next" and "Page n of m films" at the bottom.

## Film page (03, 04)

Data: `GET /api/yts/movies/:ytsId`.

Top half: poster, title (Chinese on top), English title, year, runtime, genre, rating (with its source), synopsis (TMDB's Chinese synopsis, or YTS's English one when there isn't one), "View on TMDB" (new tab); one line of storage (used, limit, how much more fits) plus a color bar.

The bottom half is the version table, one row per version: quality and source, the start and end of the info hash (monospace), codec and bit depth, audio channels, size, seeds/peers, preview while syncing ("Plays in the browser" or "Needs a preview file"), status and actions.

The rightmost cell depends on the situation:

| Situation | Shows |
| --- | --- |
| Nobody has downloaded it | "Download" |
| Nobody has downloaded it, and seeds are 0 | "Nobody is seeding right now" plus "Download anyway" |
| You have it, finished | "In Library" plus "Open" |
| You have it, in progress | "Downloading 43%", "Queued", "Paused" plus "View" (to the Downloads page) |
| You have it, download finished, still analyzing | "Analyzing" plus "Open". The prototype has "View" here; in production you can already enter the workspace at this point (see "Library") |
| You have it, failed | "Download failed" plus "Retry" |
| Someone else has it, you don't | "〈name〉 has it" or "〈name〉: downloading 43%" plus "Add to my library" |
| Someone else has it, but it failed | "〈name〉: download failed" plus "Add to my library". In the prototype this cell only says "Download failed", with no button; production lets people add it, and once added they are a holder and can press Retry themselves |
| This version is being deleted (`TORRENT_STATE`) | When Download is pressed, an explanation under that row: "This version is being deleted. Try again in a moment." (new) |

- Pressing "Download" succeeds: toast "Started downloading …." or "… is queued behind other downloads." with "View downloads".
- Not enough space (04): a red explanation expands under that row (needed, preview file, remaining, shortfall) with "Go to Storage" and "Got it".
- "Add to my library": toast "Added to your library. It takes no extra space."
- Note under the table: "A version someone has already downloaded can be added to your library without taking more space. Browsers can't always play x265 and 2160p versions; after downloading, a separate preview file is made just for syncing subtitles."
- Mark the row with the user's preferred quality (the prototype doesn't draw this).

When YTS can't be reached but data saved earlier exists for this film (`MovieDetail.stale`), the page shows as usual, with a line at the top: "Can't reach YTS right now. This is the data saved 〈time〉." (new; the time comes from `fetchedAt`). Seeds are the numbers from that time.

## Add a torrent by hand (new; Brian, 2026-10-09; D26)

Films YTS can't find are added with a magnet link or a .torrent file. Entry points:

- "＋ Add a torrent by hand" to the right of the Search page heading.
- When a search has no results, a line under the empty state, "Can't find the film on YTS? Paste a magnet link or upload a .torrent file.", and the button.
- In the search box's TMDB suggestions, when a film YTS doesn't have is selected, the line at the bottom of the list becomes "YTS doesn't have 大國民 (Citizen Kane): add a torrent by hand"; pressing it opens the window with the film already selected.

A floating window with four steps, each sliding in from the right (no motion when reduced motion is on):

1. **Source**: the note "Paste a magnet link or upload a .torrent file. Only its largest video file is downloaded; the other files aren't, and take no space." Two tabs, "Magnet link" and ".torrent file" (sliding background; left and right arrow keys switch). The magnet link is a monospace multi-line input, and Enter submits; the .torrent tab is a drop zone (while dragging over it the border turns the primary color, it grows slightly, the icon bounces up and down, and it says "Release to read it"; once chosen it turns green and says "Chosen: …"), and "Choose a file" works too. Buttons "Cancel" and "Read torrent" (disabled while empty). Errors appear above the buttons on a red background, shaking left and right once when they appear: `TORRENT_INVALID` by reason (not a magnet link, not a usable .torrent, no video file, unsafe path, no torrent info within 2 minutes), `RATE_LIMITED`, `UPLOAD_TOO_LARGE`.
2. **Waiting for torrent info** (only for magnet links, and only when the site doesn't have this torrent yet): an animation with a bouncing center and three dots circling it, "Getting the torrent details from other peers…", "Usually a few seconds, at most 2 minutes. Nothing is downloaded yet." and how many seconds it has waited. The "Use another torrent" button goes back to step 1. It polls `GET /api/torrents/inspect/:id` every 1.5 seconds.
3. **Confirm**: the card on top is "File to download": the file name (monospace), size, "The other 3 files in the torrent won't be downloaded." (when there are subtitle files, an extra green line "It comes with 2 subtitle files; they're downloaded too and added as the film's subtitles."), and small tags for the quality, source, codec and 10-bit guessed from the name. Below:
   - The torrent is already on the site: "This torrent is already on the site: 〈title〉 · year". If you already have it, it says "It's already in your library or downloads." plus "Go to Downloads"; if not, it says adding takes no space and the subtitles are shared, with the button "Add to my library" (`POST /api/torrents/:id/hold`).
   - Otherwise "Which film is it?": a search box (defaulting to the title read from the torrent name), the note "Pick one on TMDB. The title, poster and synopsis come from there, and subtitle searches use it." Below are TMDB result cards (poster, Chinese title, original title · year), floating up one by one. Once one is chosen it becomes a card with a primary-color border (with a small bounce), with "Pick another" beside it. Without a TMDB key, it explains that an administrator needs to set one.
   - Buttons "Use another torrent" and "Start download" (disabled until a film is chosen). The not-enough-space wording: "Not enough space: the video and its preview need about …, only … is free, … short."
4. **Done**: a green circle and check mark draw themselves, "Download started" ("Added to your library" when joining), title · version, "Follow it on the Downloads page. Once finished it shows up in your library." Buttons "Close" and "Go to Downloads".

On the Downloads page, a row added by hand has a small "Added by hand" tag after the version. Films added by hand that YTS doesn't have have no film page.

## Downloads (05, 34)

Data: `GET /api/torrents`, then updated by events.

Three sections: "Active and queued", "Needs attention" (only shown when something failed), "Recently finished" (the 6 most recently finished; in the prototype it's the first 6 in the list, unsorted).

Administrators have a "Show everyone's downloads" checkbox, **unchecked by default** (the prototype checks it by default; production lets administrators see their own first). When checked, the list switches to the whole site (`scope=all`) and each row also shows its holders. Rows you don't hold are view-only, with no action buttons (same as the prototype); to stop someone else's download, an administrator force-deletes it on the Storage management page.

A summary line to the right of the "Active and queued" heading (Brian, 2026-10-06): "2 downloading · 1 queued · 1 paused", the total speed, how much is left to download, and, when every film has an estimate, "all done in about 12 minutes".

Each row: thumbnail, title and version, progress bar, a line of details, status tag, actions; unfinished ones also get "Details ›" (to the Download details page; the title and thumbnail link there too). Rows currently receiving data have a shimmer running along the progress bar (not when reduced motion is on); stalled ones don't. On phones the thumbnail is on the left and the text on the right, with the status and buttons in a full-width row underneath. Under "Recently finished" is a line "Other finished films are in the Library" with a link.

| Status | Details text | Actions |
| --- | --- | --- |
| Downloading | 43% · 1 GB / 2.4 GB · 11.8 MB/s · 37 peers · about 12 min left | Pause, Cancel |
| Paused | 43% · 1 GB / 2.4 GB · Paused, space still reserved | Resume, Cancel |
| Queued | #2 in line · 2.4 GB · at most 2 downloads at once site-wide (the number comes from `Me.limits.maxActiveDownloads`) | Cancel |
| Analyzing | Downloaded. Making the waveform and speech regions | Open (the prototype has no button here) |
| Failed | 〈reason〉. The 300 MB already downloaded stays on disk until you remove it. | Retry, Remove |
| Done | Finished 2 h ago · Preview file ready (or "Making preview file 40%. You can sync subtitles in audio-only mode meanwhile") | Open |

Failure reasons:

| Code | Text |
| --- | --- |
| `STALLED` | No data for a long time. Maybe nobody is seeding |
| `METADATA_TIMEOUT` | Couldn't find any peers |
| `SIZE_MISMATCH` | The real size is larger than YTS listed, and there is not enough space |
| `NO_VIDEO_FILE` | This torrent has no video file |
| `UNSAFE_PATH` | This torrent's contents look wrong, so it was stopped |
| `DISK_FULL` | The disk is full |
| `IO_ERROR` | Writing to the disk failed |

All seven sentences in this table are new. The prototype's demo data has only one failed download, whose reason reads "No usable peers found (0 seeds)", which is hard-coded in the demo data; production shows the sentences above by code.

Cancel and Remove open a confirmation dialog first: "Cancel the download and delete what was downloaded?" / "Remove this entry and delete the 300 MB left over?" When others still hold it, the toast after confirming is "Removed from your list. Other people's downloads aren't affected."

**Resume and Retry both go to the back of the queue.** The Retry toast is "Queued again." After Resume, if there is a free slot it starts downloading right away, with no toast; only when it still has to wait is there a toast: "Back in the queue. It continues once other downloads finish." The prototype handles the order loosely; what is written here wins. When there isn't enough space to retry, it is explained under that row (see the table in "Shell").

Progress updates about every 2 seconds (how often the `torrent` program writes progress), changing only that row's numbers and progress bar, without redrawing the whole page.

### Download details (`/downloads/:torrentId`, new; Brian, 2026-10-06)

Each row on the Downloads page has a poster on the left (TMDB's, or YTS's when there isn't one), and the title links to this page. Only holders can see it (same as other per-film pages).

- **Top** (shared by all three tabs): poster, title (Chinese on top), version, status, a large percentage, progress bar, download and upload speed, time left, connected peers, downloaded / total size; "Pause" or "Resume", and "Open" once the download is finished.
- Below, three tabs (Brian, 2026-10-06): "Peer map", "Pieces", "Speed", each with a small line under its label (how many peers, how much done, current speed); left and right arrow keys switch, and the URL remembers the current tab (`?view=pieces`).
- **Peer map**: a dark world map, dark in both appearances. Each connected peer glows in its country, with an arc to this server. The server's country is detected automatically (from the addresses peers report, or guessed from `TZ` before any have reported, see [06-torrent-worker.md](06-torrent-worker.md)), and **the map is centered on it** (Brian, 2026-10-06): the world is rotated left or right until that country is in the middle, with the edges wrapping around, and each arc takes the shorter way. The legend says "This server (Taiwan, from the address peers report)" or "(Taiwan, guessed from the time zone)". When downloading from a peer, dots of light flow along the arc toward us; when uploading to a peer they flow outward, in a different color; line thickness follows speed, and a newly connected peer gets an expanding ring of light. Local-network peers are drawn next to the server. The map is decoration (`aria-hidden`); the table below lists the same content: location (flag, country name, half-masked address; the flags are flag-icons bundled with the site, and local-network and unknown peers get a gray square), client (qBittorrent 4.6.3 and the like), connection direction and type, down, up, how much the peer has. On phones the table becomes one small card per row. Under the map: "IP location data: DB-IP.com (CC BY 4.0) · Map: Natural Earth".
- **State of each piece**: one cell per piece of the file: done, downloading (flashing), not yet (brighter the more peers have it), no peer has it (red). Above 2,400 pieces one cell stands for several pieces, and partly done cells are filled in proportion. Hovering or clicking a cell explains below which piece it is, how much is done, and how many peers have it. A summary line on top: total pieces, piece size, and the number done, downloading and with no peer.
- **Speed**: download and upload speed curves for the last two minutes.
- The map, cells and curves only exist while downloading; when queued, paused, failed or done, a sentence explains. Between opening the page and the first data it says "Connecting to the downloader. This takes about two seconds…".
- The page asks `GET /api/torrents/:id/live` for data every 2 seconds; when the system setting "reduce motion" is on, neither the map nor the cells animate.

## Library (06, 25, 30)

Two tabs under the page header: "My library" (default) and "All films" (`?scope=all`; Brian, 2026-10-09), with the number of films in small text under each tab label. Left and right arrow keys switch.

**All films**: the data is `GET /api/library?scope=all`, listing every finished film in the system, visible to everyone. Note: "Every film downloaded on this site. Adding one to your library takes no extra space, and you share its subtitles and sync work with its other holders." Each card: poster, title, version, who holds it ("Held by Meiling, Ahao"; if you hold it, "In your library" comes first), the languages of confirmed subtitles ("Confirmed subtitles: Traditional Chinese, English", or "No confirmed subtitles yet" when there are none) and how many MKVs have been exported. Buttons: for films you don't hold, "Add to my library" (`POST /api/torrents/:id/hold`, with the toast "Added to your library. You can look for subtitles or export now." when done, after which the button becomes "Open workspace"); for films you hold, "Open workspace". If the film was deleted meanwhile, it says "This film has been deleted." All films has no remove or delete buttons: the deletion rules don't change and work as in "My library" below. When the system has no finished films yet, it says "No films have been downloaded yet." and offers "Go to Search".

**My library**: data: `GET /api/library`. It lists films that have finished downloading, **including ones still being analyzed**: they can already enter the workspace to look for subtitles, and their card gets an extra "Analyzing" tag.

This differs from the prototype. The prototype's library only lists films whose analysis is done, and the workspace can't be opened until analysis finishes; production lists the film the moment the download finishes and sends the "Download finished" notification, because subtitles can already be searched then without waiting for the waveform. What changes with it: the search card shows "In Library"; the cell on the film page and the row on the Downloads page get the "Open" button; the side menu count doesn't include it.

A row of filters on top, each with a count: All, No subtitles yet, Subtitles not confirmed, Ready to export, Exported.

Each card: poster, title (linking to the workspace), version, progress through the three steps (Video downloaded → Subtitles: 2 confirmed → 1 MKV exported), who it's shared with, one main button (depending on progress: "Find subtitles", "Sync subtitles", "Export MKV", "View exports"), and "Remove from Library" (when others still hold it) or "Delete whole film" (when you are the last one).

The removal confirmation text is the most important copy on this page, and the two cases must not be mixed up:

- Last holder: "You're the last holder, so the whole film gets deleted: video 1.9 GB, preview file 430 MB, all subtitles, and 1 exported MKV (1.9 GB). That frees 4.2 GB. This can't be undone." The confirm button is "Delete", and when done it says "Deleted the whole film, with its subtitles and exports." (The video size is `Torrent.diskBytes`, the preview file is `MediaStatus.previewBytes`, the exports are `LibraryItem.filmExports`; leave out the preview file or exports when there are none.)
- Others still hold it: "Remove from your library? Meiling still holds this film, so no files are deleted and no space is freed."

Empty states: a completely empty library (25) offers "Go to Search"; when a filter has nothing it only says "No films in this group. Try another filter."

## Workspace

The three tabs of a film share one page header: thumbnail, title, Chinese title, year, version, who it's shared with; "← Back to Library". Each tab label has small text underneath describing the current state ("2", "Not confirmed", "1 MKV").

Data: `GET /api/library/:torrentId`. A film whose download isn't finished can't enter the workspace (`MEDIA_NOT_READY`): it shows "This film is still downloading." and a button to the Downloads page (new). Films that finished downloading and are still being analyzed can enter.

When the workspace opens, if the film has never been analyzed (`analysis` is `none`), the frontend calls `POST /api/media/:id/analyze` once.

### Subtitles (07, 08, 31)

Three sections.

**This film's subtitles**: the added ones, one row each: language, source, release name, status ("Confirmed · 81%", "Not confirmed"; when not confirmed but already scored, "Not confirmed · 85%"), who added it, "Sync / Sync again", "Remove". The removal confirmation is "Remove these subtitles and their sync?". Note underneath: "A film's subtitles and their sync are shared by all its holders: once someone syncs them, nobody else has to."

**Find subtitles in all sources**:

- Language toggle buttons (at least one selected).
- "Search all sources" → searching → "Search again".
- A status tag for each source: Not searched, Searching…, n results, an error message plus "Retry", Disabled, and Zimuku is always "You download it yourself". **Each source updates on its own; whichever answers first is shown first.**
- Source error messages follow `ProviderStatus.error.code`:

  | Code | Text |
  | --- | --- |
  | `RATE_LIMITED` | Over the limit of 20 a minute (the prototype's sentence; with `retryAt`, append ", retrying automatically in about n s", new) |
  | `UNREACHABLE` | Can't reach this source (new) |
  | `BAD_RESPONSE` | Can't understand this source's reply. It may have changed (new) |
  | `NOT_CONFIGURED` | Not set up. JustSubtitles: "Needs a TMDB key to identify this film"; Assrt (Shooter): "No API token set" (new) |

- Candidate table: source, language (plus the source's original label), release name, uploader and flags, sync score, "Add" or "Added".
- Two special candidate states: while fetching the file or processing an uploaded file, it shows "Processing…" (new); failed ones show the reason and "Remove" (new), and can't be added:

  | `fetchError` | Text |
  | --- | --- |
  | `DOWNLOAD_FAILED` | Couldn't fetch this file |
  | `ARCHIVE_INVALID` | The archive won't open, or its contents are over the limits |
  | `NO_SUBTITLE` | The archive has no subtitle file |
  | `PARSE_FAILED` | Couldn't read a single subtitle line |

  When pressing "Add" returns `CANDIDATE_UNAVAILABLE`: if the reason is one in the table above, show that sentence; if the reason is `TIMEOUT`, show "Still fetching this file. Press it again in a moment." (new)
- Once there are candidates, the ranking button appears. Its text: "Auto-align and rank all" before any ranking, "Aligning…" (disabled) while running, and "Rank again" after ranking. While running, each row shows "Calculating…", and finished ones show their score; once all are done they are sorted by score, and the highest in each language is marked "Recommended".
- Assrt (Shooter) results need a source credit and link next to them (its terms of use require it): "Subtitles provided by assrt.net" (new; the name and address come from `ProviderStatus.credit`).

Flags: Matches the YTS release, Hearing impaired, Converted from Big5 to UTF-8, Can convert to Traditional, ASS styling, Bilingual, Script checked after download, Archive.

The toast after "Add" depends on the case: "Added.", "Added. From the content, it's Traditional Chinese.", "Added, and converted from Simplified to Traditional Chinese.", each followed by "Next step: sync."

**Zimuku** and **Upload your own** sit side by side: see [07-subtitle-providers.md](07-subtitle-providers.md). The upload area accepts drag and drop or a click to pick.

While analysis isn't finished, "Auto-align and rank all" is disabled with the reason explained; searching and adding aren't affected.

### Sync (09)

A card on top picks "Subtitles being synced" and shows their status ("Confirmed · 81%" or "Not confirmed"), plus a sentence about the preview source. Below is the workbench, specified in [09-sync-workbench.md](09-sync-workbench.md).

The preview-source sentence, by case:

| Case | Sentence |
| --- | --- |
| Plays directly | The browser can play this version directly. |
| Uses a preview file | This version is x265, so the preview uses a separate 480p preview file (430 MB) with exactly the same timing. |
| Preview file still converting | This version is x265 and its preview file is still being made (40%). You can sync in audio-only mode meanwhile. |
| No preview video, and none being made | This version is x265, which the browser can't play, so there is only audio. To see the picture, press "Make preview file" below. (new) |

Each sentence is followed by: "Press "Confirm sync" in the workbench below to mark these subtitles as confirmed, then pack them in Export."

When there are no subtitles yet: "No subtitles to sync yet. Add some on the Subtitles tab first." plus "Go to Subtitles".

When the URL doesn't name a subtitle (`/library/:torrentId/sync`), open the first unconfirmed one; if all are confirmed, open the first one.

### Export (10, 11)

**Subtitle tracks to pack**: only confirmed subtitles are listed. Each row: a checkbox with the language name, source, language tag (monospace `zh-TW`, `zh-CN`, `en`; `zh` counts as `zh-TW`), and a "Shown by default" radio button. All are checked by default, and "Shown by default" falls on the first checked one; unchecked rows have their radio button disabled. When some subtitles are still unconfirmed, a reminder links to the Sync tab ("1 subtitle not confirmed yet: English." "Go sync"). When there are no confirmed subtitles at all: "No confirmed subtitles yet. Only subtitles with a confirmed sync can be packed." and the button is disabled. Unchecking everything and pressing start shows "Pick at least one confirmed subtitle. If there aren't any, sync first." under the list.

**File name**: defaults to `Title.Year.Quality.zh-TW.mkv` (non-alphanumeric characters in the title become dots). Rules: ends in `.mkv` (with something before `.mkv`), can't contain `/ \ : * ? " < > |`, at most 200 characters. The server additionally rejects control characters (line breaks and the like), names starting with a dot, and names with leading or trailing spaces; these all fall under the first sentence (`CHARACTERS`). Under the field it normally says "Video and audio are copied as-is, not re-encoded, so quality is unchanged."; on an error that becomes "The file name must end in .mkv and can't contain / \ : * ? " < > |" or "The file name can be at most 200 characters." (new)

**Space note**: when there is enough, "The export is about 1.9 GB, the same size as the original. 3.7 GB is free now, 1.8 GB after exporting." When there isn't (11), in red: "**Not enough space to export.** The export is about 1.9 GB, but only 1.2 GB is free, 700 MB short." plus "Go to Storage", and "Start export" is disabled (the prototype doesn't disable it; it only shows a message after the press). The size here is `Workspace.exportNeedBytes`, the amount actually used in the space check (the original file's size plus about 1%); the prototype uses the original file's size directly.

**One export per film at a time** (Brian, 2026-10-06): while this film has a queued or packing export, "Start export" is disabled, its text becomes "Exporting…", and next to it: "This film is being exported. You can start another once it finishes. Progress is in the list below."

Wording: the action is called "export" ("Start export", "Export MKV", "Export finished"); the in-progress state is called "Packing"; a finished one is "Ready to download".

Small text next to "Start export": "Exports aren't deleted automatically. They count toward the storage limit until someone deletes them."

**This film's exports**: file name, subtitle tracks, who, when, size, progress ("Packing 43%") or "Ready to download", "Download", "Delete". Toast on start: "Packing started. Nothing is re-encoded, so it usually takes under a minute." Underneath: "Download links can resume. Once it is on your own computer, come back and delete the file here."

Queued ones show "Waiting to pack" and can be deleted (new). Failed ones show the reason and "Delete"; to try again, press "Start export" again (new):

| `errorCode` | Text |
| --- | --- |
| `SOURCE_MISSING` | Can't find the original video file. It may have been deleted |
| `MUX_FAILED` | Packing failed |
| `VERIFY_FAILED` | The packed file is incomplete |
| `DISK_FULL` | The disk is full |

## Storage (12)

See "How it appears in the interface" in [10-storage.md](10-storage.md). Items in "What I hold" can be removed right here; exports you made are listed here too and can be downloaded and deleted. This page's confirmation text is shorter than the Library page's; the full text and button labels are in "Confirmation wording" in [10-storage.md](10-storage.md).

## Profile (13)

Six sections: Basics (display name), Interface language (Follow the browser, 繁體中文, English; saved and switched as soon as it changes), Film posters ("Poster version": Follow the interface language, Taiwan, Hong Kong, China, United States (English original), Japan, South Korea; with the note "Posters come from TMDB. When the chosen country has no poster for a film, TMDB's default one is used." Saved as soon as it changes, with the toast "Poster version updated.", and the posters on screen change immediately), Subtitle preferences (languages to look for by default, convert Simplified Chinese to Traditional automatically, show a second language on the Sync tab by default, preferred quality), Change password, Signed-in devices.

Preferences are saved as soon as they change. At least one language must remain: "Keep at least one language."

Change-password messages: "Enter your current password.", "The current password is wrong." (new), "The new password must be at least 8 characters.", "The new passwords don't match." On success the toast is "Password changed. Other devices need to sign in again."

Signed-in devices: each row is the operating system and browser ("Windows · Edge"; when unrecognized, "Unknown device", new) and when it was last used. The current device is marked "This device" and has no button; the others have "Sign out this device", which shows the toast "That device has been signed out."

## Admin pages

### Overview (14)

Four number tiles, each linking to its page. Each tile has a small heading, a big number and one line of notes:

| Tile | Big number | Note |
| --- | --- | --- |
| Storage | Amount used | Limit 26 GB, 3.7 GB free |
| Downloading | 2 / 2 (active / site-wide limit) | "1 queued" or "Nothing queued" |
| Users | Number of active users | 1 disabled · 2 open invites |
| Background tasks | Number running | The kind and progress of the current one, e.g. "Make preview file: 70%"; with none, "No tasks right now" |

"Needs attention" lists every problem. Each item is a tag (a red "Problem" or a yellow "Warning"), a sentence and a button; with no problems it says "Nothing needs attention right now." Below, "Sources" and "Recent activity" sit side by side.

Each item in `AdminOverview.problems` is one row. The frontend writes the sentences from `code` and `data`; those marked (new) aren't shown in the prototype, and are written in the same voice:

| Code | Tag | Sentence | Button → page | `data` |
| --- | --- | --- | --- | --- |
| `OVER_LIMIT` | Problem | Usage is over the storage limit, so nobody can download or export. | Handle → Storage management | |
| `NEARLY_FULL` | Warning | Only 1.6 GB of storage left. | View → Storage management | `freeBytes` |
| `DISK_LOW` | Problem | The disk itself has only 1.2 GB free. (new) Threshold: free space below twice the system reserve (`STORAGE_RESERVE_GB`) | View → Storage management | `availableBytes` |
| `FAILED_DOWNLOAD`, one per failed download | Problem | Download failed: Charade 1080p BluRay (Meiling). 〈reason〉, 300 MB left over. | View → Downloads | `movieTitle`, `version`, `requestedBy`, `errorCode`, `bytes` |
| `YTS_NOT_CONFIGURED` | Problem | The YTS address isn't set, so Search doesn't work right now. (new) | Go to settings → Sources | |
| `YTS_DOWN` | Problem | Can't reach YTS, so Search doesn't work right now. | Update address → Sources | |
| `SOURCE_DOWN`, one per source with issues | Problem when unreachable, Warning otherwise | Assrt (Shooter): over the limit of 20 a minute, postponed automatically. | View → Sources | `source`, `code` |
| `FAILED_TASK`, one per analysis or preview asset currently in a failed state | Warning | Make preview file failed: Charade. 〈reason〉. | View → System status | `kind`, `movieTitle`, `errorCode` |
| `SERVICE_DOWN` | Problem | Downloader is not responding. (new) | View → System status | `service` |
| `MISSING_FILES` | Warning | The last recount found 2 items with missing files. (new) | View → Storage management | `count` |
| `ORPHANS` | Warning | The disk has 1 folder with no record, taking 1.2 GB. (new) | View → Storage management | `count`, `bytes` |
| `NO_HOLDERS` | Warning | 2 items have no holder. (new) | View → Storage management | `count` |

The `FAILED_DOWNLOAD` reason uses the table in the "Downloads" section; the name in parentheses is whoever started the download. The `FAILED_TASK` reason uses the table in the "System status" section; it lists what is in a failed state **now**, and disappears once a retry succeeds or the film is removed; it is not a count of past failures.

"Sources" has one row per source: name, status tag, how long ago it was checked ("3 min ago"). The names follow the prototype: YTS (film search), TMDB (titles and IDs), JustSubtitles, YIFY Subtitles, Assrt (Shooter), Zimuku. Status tag text: "Working", "Issues", "Unreachable", "Manual" (Zimuku), and "Disabled" (new). Underneath, a "Sources" button. The source status details ("Response 200 · 0.4 s" and the like) are shown on the Sources page, not here.

"Recent activity" is the latest 6 entries: "**Name** action: target" plus the time, with a "Full log" button underneath.

### Users & invites (15)

User table: name and username, role, status, last seen, number held, actions (change role, disable/enable, reset password, remove). Your own row has no buttons, only the sentence "You can't change your own role or disable yourself".

- "Reset password" expands a one-time link and "Copy" under that row.
- The "Remove" confirmation: "Remove 〈name〉's account? The 2 items they hold alone stay on disk and must be deleted by hand in Storage management." When they hold nothing alone, the second half becomes "They hold no files alone."
- Actions that would leave the system without an administrator (`LAST_ADMIN`): explained under that row as "Keep at least one active administrator." (new)
- Under the table: "A disabled account can't sign in, but the files it holds are left alone."

Invites: created by picking a role and a validity period (1, 3, 7 days). The list shows the invite code, role, status, creator, "Copy link" and "Revoke" (or "Clear").

### Storage management (16, 33)

See [10-storage.md](10-storage.md). The limit's explanatory text updates live while typing. The force-delete confirmation text is in "Confirmation wording" in [10-storage.md](10-storage.md).

After pressing "Recount usage", the button becomes "Recounting…" (new); when it finishes, the page updates itself and a toast reports the result: when the numbers match the records, "Rescanned the disk. Actual usage matches the records."; when something was corrected or found, it says how many entries were corrected and how many orphan folders and missing items were found (new; the numbers come from that job's `summary`).

A section the prototype doesn't have: "Found while recounting". Orphan folders are one per row (location, folder name, size, "Delete"); missing files are one per row (which film's what), view only. When nothing was found this section isn't shown.

### Sources (17)

**Three horizontal tabs** (Brian, 2026-10-06: all the cards used to be laid out on one long page, which was too long): "Film data" (YTS, TMDB), "Subtitle sources" (JustSubtitles, YIFY Subtitles, Assrt (Shooter), Zimuku, shared settings), and "Auto-align". They look like the workspace tabs, and each tab label has a line of small text underneath describing the current state: for the first two, the worst state among their sources ("1 unreachable", "1 with issues", "Some not tested", "All working"; disabled sources don't count); for "Auto-align", something like "Speech recognition on · Claude". The current tab is in the URL (`?tab=movies|subtitles|align`), so a reload or a "View" link from the Overview lands on the same tab; left and right arrow keys switch tabs. On wide screens the cards sit in two columns, on phones in one, with the tab labels in a single row that scrolls sideways.

One card per source, with its status next to the title (each source's latest status comes back with `GET /api/admin/settings`). Fields and validation are in [13-settings.md](13-settings.md). Key fields are password boxes; ones already set show "Set. Leave empty to keep it". Each card has "Test", which shows "Testing…" when pressed, with the result shown next to the button (the frontend writes the sentence from the result's code; the mapping is in [13-settings.md](13-settings.md)). In the prototype each card has only one test; in production the JustSubtitles card gets an extra "Test the official SubDL API" (new), because the two modes can be tested separately. TMDB has a card of its own, with its own test.

Don't build the prototype's "Prototype switch: simulate YTS being unreachable".

### LLM settings (new, Brian 2026-10-07)

`/admin/llm`, after "Sources" in the menu. The rules are in [18-llm.md](18-llm.md).

- "Add profile" in the top right.
- The "Profiles" card: a line of explanation (priority order, weight sharing, falling through to the next layer, cooling down for 60 seconds / 10 minutes when a key is rejected), and a table: name, provider, model, "Layer 1 · weight 3", status (Disabled / Cooling down until 14:05 (rate-limited) / Working), key (Key set / No key), "Edit", "Delete" (delete asks for confirmation first). With no profiles it is an empty state explaining that profiles are used for subtitle translation and auto-align.
- The "Translation limit" card: how many translations each person can start per hour (0 to 100).
- The "Recent usage" card: time, profile, purpose (Translation / Auto-align / Test), user, result, how many seconds it took.
- Adding and editing happen in a floating window; the field order is in "Floating window" in [18-llm.md](18-llm.md).

"Sources → Auto-align" only keeps the speech recognition switch, plus a sentence saying the language model is now set up on the "LLM settings" page, with a link.

The workspace's "Subtitles" tab: each subtitle gets an extra "Translate", which opens the translation floating window (target language, form); the "Translation" section under the table lists running, failed and cancelled translations (progress bar, "Cancel translation", "Resume"). A finished translation becomes a subtitle directly, with the source "AI translation".

### Download settings (19)

Four sections: Count and speed, Connection, Seeding, After a download finishes. The page is one form, and **when there are unsaved changes the save bar at the bottom says so**; "Revert to current settings".

Differences from the prototype: the incoming port is read-only (D31), and "Test whether outside peers can connect" is replaced by a display of incoming connections (D32); there are two more fields (tracker list, stall timeout) (D37).

### System status (20)

Service table (container, purpose, status, uptime): four rows, `api`, `torrent`, `media`, `postgres`. `proxy` isn't in the table (if this page opens, it's running). The purpose column is a fixed description plus the version the service reports, e.g. "Downloader (WebTorrent 3.0.21)". A service that hasn't reported for more than 30 seconds shows "Not responding" (new). While the page is open it refetches every 10 seconds.

Background task table: task (the kind's display name: Analyze waveform and speech, Speech recognition, Make preview file, Auto-align, Rank subtitles, Export MKV, Recount usage), item (film title or file name), status ("Running", "Waiting", "Done", "Failed", and "Cancelled", new), details (progress while running, "Took 40 s" when done, the reason when failed), actions. Only failed jobs that can be retried have "Retry" (`Task.retryable`: analysis, speech recognition, preview file, recount). A preview file retry may be refused for lack of space, which is explained in that row.

Failure reasons (`Task.errorCode`; the codes for analysis and preview assets are the same as in `MediaStatus.errors`, and the sentences are all new):

| Code | Text |
| --- | --- |
| `NO_AUDIO` | This file has no audio track |
| `PROBE_FAILED` | Can't read this video file. It may be damaged |
| `PEAKS_FAILED` | Making the waveform failed |
| `SPEECH_FAILED` | Detecting speech failed |
| `TRANSCODE_FAILED` | Converting failed |
| `TIMEOUT` | Took too long with no result |
| The four export codes | Use the table in the "Export" section |
| Anything else | Something went wrong (with the code shown after it, to help with reporting) |

Disk summary: "The data disk has … with … reserved for the system. The storage limit is …, and … is used."

This page and the other admin pages may use technical terms (container names, WebTorrent, ffmpeg, tracker, DHT, port numbers): they are for administrators.

### Activity log (21)

Time, user, action, target, filterable by user. 50 entries per page, with "Older entries" at the bottom to page back (the prototype has no paging; new). The user column uses the name at the time of the entry (`actorName`), so entries from accounts that have since been removed still make sense. The frontend writes the action and target sentences from the code and data; the mapping is in [12-auth.md](12-auth.md).

## Things in the prototype that are fake and must not reach production

- "Prototype shortcuts" on the sign-in page, and "View as …" and "Reset demo data" in the account menu
- "Prototype switch: simulate YTS being unreachable" in Sources
- "Prototype: films, users and subtitles are all demo data…" at the bottom of every page
- The "Problems with these subtitles" menu at the top of the Sync tab
- Wording like "Demo data" and "Progress in the prototype is a sped-up simulation"
- The demo domains `paiban.home.example` and `yts.example`
- The prototype's sentences explaining that something is fake: "The prototype doesn't really open external sites…" when opening Zimuku, "The prototype has no real file to download…" when downloading an export, "Received …. In production the server unpacks it…" when uploading an archive, "Read …: n lines." when uploading a subtitle file, and "Actions you take in the prototype are added here." on the Activity log page
- The line under the invite code field on the registration page that hints at the demo invite code

## Notifications

The prototype has four kinds of notification (download finished, download failed, export finished, subtitles synced). Production has six (`Notification.kind`), and the frontend writes the sentences from `data`:

| Kind | Sentence | Where clicking goes |
| --- | --- | --- |
| `download.completed` | Download finished: 〈title〉 · 〈version〉 | That film's workspace |
| `download.failed` | Download failed: 〈title〉 · 〈version〉 | Downloads page |
| `export.completed` | Export finished: 〈title〉 | That film's Export tab |
| `export.failed` | Export failed: 〈title〉 (new) | That film's Export tab |
| `subtitle.confirmed` | 〈name〉 synced the 〈language〉 subtitles of 〈title〉 | That film's Sync tab |
| `item.deleted` | Administrator 〈name〉 deleted 〈item〉: 〈film title or file name〉 (new). The item follows `itemKind`: video, video still downloading, failed download leftovers, preview file, export | Library |

Where clicking goes: the prototype always opens the workspace's default tab for that film; production opens the matching tab directly. When the target no longer exists (`link` is null), it goes to the Library instead; the two export kinds go to the Storage page instead, because once the film is deleted, that is where the export is downloaded.

"Download finished" is sent the moment the download finishes, without waiting for the audio analysis (the prototype sends it after analysis). When a download or an export finishes and that person has the site open, a toast also pops up ("Download finished: … [Open]", "Export finished: …").

## Carrying over the prototype's checks

Of the 72 items in `prototype/platform/e2e.cjs`, the ones below are tied to things only the prototype has. Keep the behavior, change the approach:

| Prototype check | How production does it |
| --- | --- |
| `search by Chinese title` | Doesn't apply: production doesn't do Chinese-title search. This is the only item dropped entirely |
| `search lists all demo films`, `sort by rating puts Metropolis first` and similar checks comparing film counts and titles | Run them against the fake YTS, whose catalog is the 14 films it serves |
| `downloads page lists active, failed and finished` (counts 8 or more rows) | That number includes other people's downloads. Production's "Show everyone's downloads" is unchecked by default: check it first, or count only your own |
| `progress moves on its own` (the sped-up animation) | Use local seeding and wait for real progress |
| `one source failing does not hide the others`, `retry brings the third source in` (the prototype has Assrt (Shooter) fail the first time) | Make the fake subtitle source return a quota error (`30900`) the first time, then work normally |
| `uploaded file is read` (the prototype reads the file in the browser and shows the toast "Read …: n lines.") | The file is uploaded to the server. Check that the list first shows a "Processing…" row, which then becomes a candidate that can be added |
| `a second export no longer fits and is refused` (message shown only after pressing) | "Start export" is disabled. Check the button's state and the red explanation |
| `download settings validate each field` (including the incoming port field) | The incoming port is read-only and has no field. Test the other fields as before, plus the tracker list and stall timeout |
| `connection test reports back`, `search shows the YTS outage with a way out` (using the "simulate YTS being unreachable" switch) | Stop the fake YTS, or set the address to somewhere unreachable |
| Signing in with any password, switching identity from the account menu, resetting demo data | Use accounts created by the tests, and really sign in and out; each test prepares its own data |

## What every page needs

- Loading, empty and error states (follow the prototype where it draws them; where it doesn't, follow similar pages)
- Keyboard operable, with visible focus
- No horizontal scrollbar at 400 px wide; tables that are too wide scroll sideways inside their own container
- Light and dark themes
- Form error messages appear next to the field, and focus moves to the first field with an error
- Numbers, times and sizes use tabular figures
