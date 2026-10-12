# 01 Product scope

## In one sentence

Paiban (拍板) is a self-hosted website: search for films on it, download them, find subtitles, line the subtitles up, and end up with an MKV that has subtitles. The whole process never leaves the browser.

Where the name comes from: a 拍板 is the clapperboard used on set to line up sound and picture, and "拍板" also means "to make the final call". Those are exactly the two core actions of this site: line the subtitles up, then confirm.

## Who uses it

| Role | What they can do |
| --- | --- |
| member | Search, download, manage their own library, find subtitles, sync, export, see how much space they take up, change their own settings |
| administrator | Everything a member can do, plus: invite and manage users, set the storage limit, delete any file, configure each source, adjust download settings, see system status and the activity log |

The number of people is single digits to a dozen or so. There's no need to design for many users, but two people working on the same film at the same time has to be considered.

## Main flow

1. **Search**: type a title (mainly in English) and see posters, years, ratings and which qualities are available.
2. **Pick a version**: open the film page and see every version of this film on YTS (quality, source, codec, audio channels, size, seeds), and whether that version fits.
3. **Download**: press Download. If there's enough space it starts (or queues); if not, the user is told how much is missing and where to clear it. When someone else has already downloaded the same version, it becomes "Add to my library".
4. **Wait for the download to finish**: progress is visible on the Downloads page. When done, the system automatically analyzes the sound (waveform, where people are talking), and for versions browsers can't play directly it also makes a preview file.
5. **Find subtitles**: in the film's workspace, press search once to query all sources at the same time. You can also upload your own. You can have the system auto-align every candidate once and rank them by score.
6. **Sync**: add a subtitle, then go to the workbench. Press "Auto-align", listen to a few checkpoints, fine-tune if it's off, and finally press "Confirm sync".
7. **Export**: choose the subtitle tracks to pack and the default track, then press Start. Audio and video aren't re-encoded; it usually takes less than a minute.
8. **Download the MKV**: download it from the browser, with resume support. When the download finishes, remember to come back and delete the export on the site, so the space is freed.

Every film in the library shows which step it has reached: video → subtitles → export.

## Terms

Documents, code and the interface all use the same vocabulary. The left column is the interface wording (English, with the Traditional Chinese in parentheses), the middle is the English in code.

| Interface | Code | Meaning |
| --- | --- | --- |
| version (版本) | version | One torrent of a film on YTS, e.g. "1080p BluRay x264" |
| download (下載) | torrent | One download item in the system. There is only one per info hash site-wide |
| Library (片庫) | library | The finished films a user holds |
| holder (持有人) | holder | A user who added a download to their own library. There can be many |
| workspace (工作區) | workspace | A film's page, with three tabs: "Subtitles", "Sync", "Export" |
| candidate subtitles (候選字幕) | candidate | Subtitles found by search or uploaded, but not yet added |
| subtitles (字幕) | subtitle | Subtitles added to a film. Shared by every holder of that film |
| line (句) | cue | One line of a subtitle, with a start time, an end time and text |
| sync workbench (同步工作台) | workbench | The screen where subtitles are lined up |
| offset (位移) | offset | Seconds the whole subtitle is moved earlier or later |
| rate (速率) | scale | The stretch factor of subtitle times, used to fix differing frame rates (e.g. 25 fps vs 23.976 fps) |
| segment (分段) | segment | A run of consecutive lines sharing one offset and rate. Different cuts need two or more |
| anchor (對齊點) | anchor | The user saying "this line is at this time" |
| checkpoint (檢查點) | checkpoint | A few lines the system picks for the user to confirm by ear |
| sync score (對齊分數) | score | The share of the time subtitles are on screen during which speech is detected. Only a hint |
| sync doc (同步文件) | sync doc | A subtitle's current sync result: segments, per-line edits, anchors, checkpoints |
| draft / confirmed (草稿 / 已確認) | draft / confirmed | The two states of a subtitle. Only confirmed subtitles can be exported |
| preview file (預覽檔) | proxy | A low-resolution copy for the browser to play, used only for syncing subtitles |
| audio-only mode (只有聲音的模式) | audio-only | Syncing subtitles with the sound and waveform while the preview file isn't ready yet |
| export (匯出檔) | export | The packed MKV |
| storage limit (容量上限) | limit | The site-wide limit set by an administrator |
| reserved (預留) | reserved | Space already counted in usage for something that hasn't finished downloading |

## Supported browsers

The latest two major versions of Chrome, Edge, Firefox and Safari (including iOS Safari).

- Every browser can play H.264 versions directly.
- HEVC (x265) barely plays in Firefox, and in Chrome and Edge it depends on the hardware. So x265 and 10-bit versions always get a preview file rather than relying on the browser.
- The sync workbench uses `requestVideoFrameCallback` (supported since Chrome/Edge 83, Safari 15.4, Firefox 132). Without it, it falls back to `requestAnimationFrame`; the features are the same, only the subtitle display timing is a bit coarser.
- The layout must not show a horizontal scroll bar on a 400 px wide phone. The sync workbench is usable on a phone, but the desktop is the main use case.

## Things that should put people at ease

These are the basis for judgment calls when writing every page.

- **The system never deletes anything behind your back.** Every deletion is something a person pressed, and before pressing it, they're told clearly what will be deleted and how much space it frees.
- **Lack of space is reported before starting.** Users must not wait an hour only to see it fail.
- **One broken source doesn't affect the others.** If any one site in the subtitle search can't be reached, the others show as usual.
- **The score is only a hint.** After auto-align, users are still asked to listen to a few lines, and the interface keeps guiding them to the "confirm" step.
- **Work done isn't wasted.** Subtitles and sync results are shared by every holder of the film; once someone has lined them up, everyone else can use them directly.

## Legal note

This section is information only, not legal advice. Most content on YTS isn't authorized by the rights holders; BitTorrent also uploads to others while downloading. In most places this kind of use carries legal risk, borne by whoever hosts and uses this site. Development and testing always use the synthetic material in `fixtures/` and freely distributable videos (D29).
