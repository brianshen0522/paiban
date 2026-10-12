# Spec change log

Places where the implementation differs from the original spec. Record one entry for every change, and update the affected documents along with it: this is the record of "what changed and why"; the documents themselves must always be current. Newest entries go at the top.

Format of each entry:

```text
## 2026-10-12 The language field in Assrt responses

- Before: docs/07-subtitle-providers.md says the keys of lang.langlist are langcht, langchs…
- Now: …
- Why: the real response recorded in phase 0 is…
- Files changed: docs/07-subtitle-providers.md, reference/providers/assrt.search.sample.json
- Confirmed by Brian: yes / no / not needed
```

---

## 2026-10-12 The documents are in English

- Before: everything under `docs/`, `AGENTS.md`, `README.md` and the other READMEs was in Traditional Chinese; code comments cited doc sections by their Chinese headings.
- Now: all of them are in English. Chinese stays only where the Chinese itself is the subject (the style rules for the zh-TW copy in 17-ui.md, language labels, Chinese example titles and subtitle lines, the site name 拍板). Code comments cite the English headings. Plan steps (階段) are called "phases" throughout, matching `docs/reports/phase-N.md`. D13 now records the bilingual interface and the English docs; reports go into `docs/reports/` in English. AGENTS.md: docs in English; conversation and reports to Brian stay in Traditional Chinese. Interface text quoted in the docs is the English interface copy (`apps/web/src/copy/en.ts`) where it exists.
- Why: Brian is publishing the repository on GitHub.
- Files changed: every Markdown file in the repository, code comments that cite doc sections
- Confirmed by Brian: yes

## 2026-10-10 Each person picks the country for posters

- Before: posters were always fetched from TMDB with zh-TW (the Taiwanese poster if there is one), and one copy was stored for each downloaded film.
- Now: Profile has a new "Film posters" setting: follow the interface language (default; Chinese uses Taiwan, English uses the US), or Taiwan, Hong Kong, China, the US, Japan, Korea. The poster endpoint takes a new `region` parameter; the server uses TMDB `language=` to get that country's poster, stores one copy per country for each film in the library, and deletes them when the film is deleted. `UserPrefs.posterRegion`, `PosterRegion`, `POSTER_REGIONS`.
- Why: Brian wants the poster country to be changeable in settings; he agreed to make it each person's own choice.
- Files changed: docs/04-api.md, docs/05-yts.md, docs/11-pages.md, docs/13-settings.md, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes

## 2026-10-09 Subtitles from the torrent

- Before: subtitle files in a torrent were of no use (torrents added by hand didn't even download them), and subtitle tracks embedded in the video were ignored too.
- Now: after the video is probed, the `.srt`, `.ass`, `.ssa`, `.vtt` files in the torrent folder and the text subtitle tracks in the video (extracted with ffmpeg) are automatically added as this film's subtitles: source "From the torrent" (`provider = 'bundled'`), not yet confirmed, Simplified converted to Traditional according to the preference of whoever started the download, duplicates skipped. YTS downloads and downloads added by hand work the same way; for a torrent added by hand, the subtitle files are also selected for download, and they count toward the reserved space. `TorrentInspection` gets `subtitleFiles`; `ProviderId` gets `bundled`; migration `0008_bundled_subtitles.sql`; a new event `{type: 'subtitle', id}` is sent by `media` and relayed by `api`.
- Why: Brian wants the subtitles that come with a torrent added too; he chose to take both external files and embedded subtitle tracks, add them directly as subtitles, and include YTS downloads as well.
- Files changed: docs/03-data-model.md, docs/06-torrent-worker.md, docs/08-media-pipeline.md, docs/11-pages.md, db/schema.sql, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes

## 2026-10-09 Adding a torrent by hand (magnet link, .torrent file)

- Before: AGENTS.md absolute rule 4 and D26: only info hashes from YTS search results are accepted; the product has no way to paste a magnet link or upload a .torrent file.
- Now: everyone who is signed in can paste a magnet link or upload a .torrent file in the "Add a torrent by hand" window, pick a film on TMDB, and download it; only the largest video file is downloaded. For magnet links, the `torrent` service fetches the torrent info in memory. Trackers are filtered, web seeds are dropped, and each person can inspect 30 times per hour. New table `torrent_inspections`; `movies.yts_id` can be empty; `torrents` gets `origin`, `metainfo`, `trackers` (migration `0007_manual_torrents.sql`). New endpoints `POST /api/torrents/inspect`, `GET /api/torrents/inspect/:id`, `POST /api/torrents/manual`, `GET /api/movies/:id/poster`; error codes `TORRENT_INVALID`, `TMDB_NOT_CONFIGURED`, `TMDB_UNREACHABLE`; `Torrent.movie.ytsId` can be null, `Torrent.origin`; activity log action `torrent.manual`.
- Why: Brian wants to be able to add a film by hand when YTS doesn't have it. He confirmed dropping the original rule, letting everyone use it, picking the film from TMDB, and downloading only the largest video file.
- Files changed: AGENTS.md, docs/00-decisions.md (D26), docs/03-data-model.md, docs/04-api.md, docs/06-torrent-worker.md, docs/10-storage.md, docs/11-pages.md, docs/12-auth.md, db/schema.sql, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes

## 2026-10-09 All films library

- Before: each person could only see the films they hold. To use a film someone else downloaded, you had to find the same film and the same version in Search, then press "Add to Library". Only administrators could see which films were in the system.
- Now: the Library page has a new "All films" tab listing every finished download, who holds it, and the languages of its confirmed subtitles; films you don't hold can be added with one click on "Add to my library" (new endpoint `POST /api/torrents/:id/hold`; no YTS request, no extra space used). `GET /api/library` gets `scope=all`, and `LibraryItem` gets `confirmedLanguages`. The holder model and the deletion rules (D21, the last holder deletes the whole film) are unchanged.
- Why: Brian wants everyone to be able to see every film; Brian chose the scope (a site-wide list plus one-click adding) and the deletion rules (keep as is).
- Files changed: docs/04-api.md, docs/11-pages.md, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes

## 2026-10-08 Bilingual interface (Traditional Chinese, English)

- Before: the interface was Traditional Chinese only, and the copy file `zh-TW.ts` exported `t` directly.
- Now: there is an English copy file `en.ts` with exactly the same keys as the Chinese one (enforced by type checking). Each person picks a language in the top bar, on the sign-in page, or in Profile; it is stored in `users.prefs.locale` (`'zh-TW'`, `'en'`, `null` follows the browser). Notification and activity log sentences follow the viewer's language; the names of AI-translated subtitles and the subtitle track titles in exported MKVs use the language of the person who made them. Film titles and summaries use Chinese or the original according to the interface language. The contract's `UserPrefs` gets `locale`, a `UiLocale` type, and `MovieDetail` gets `summaryEn`. No migration (`prefs` is jsonb).
- Why: Brian asked for the system to be bilingual; Brian chose the languages, the default, and the scope.
- Files changed: docs/17-ui.md, docs/11-pages.md, docs/04-api.md, docs/13-settings.md, docs/08-media-pipeline.md, docs/18-llm.md, AGENTS.md (language table), packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes

## 2026-10-07 Ollama split out from "self-hosted"

- Before: a single "self-hosted" option covered Ollama and other OpenAI-compatible services, all via `/v1/chat/completions`.
- Now: a new provider, "Ollama", uses Ollama's own `/api/chat`, can set a length limit (`num_ctx`, default 16384), turns off reasoning with `think: false`, and constrains answers with a JSON schema; the model list comes from `/api/tags`. "Self-hosted" is renamed "Self-hosted, OpenAI-compatible (vLLM, LM Studio…)". The contract's `LlmProvider` gets `ollama` and `LlmParams` gets `contextLength`; migration `0006_llm_ollama.sql`. Existing "self-hosted" profiles are not affected.
- Why: Brian asked why the two were the same option; Ollama's default context is small and can't be adjusted through the compatible interface, so translations silently lose lines. Brian agreed to split them.
- Files changed: docs/18-llm.md, docs/08-media-pipeline.md, db/schema.sql, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes

## 2026-10-07 LLM settings page and subtitle translation

- Before: the language model was used only for auto-align, configured under "Sources → Auto-align", and there was only one (Claude or OpenAI-compatible) with the key `llmKey`. There was no subtitle translation.
- Now: a new admin page, "LLM settings" (`/admin/llm`), where you can create multiple profiles (OpenAI, Anthropic, Azure OpenAI, Azure AI Foundry, OpenRouter, self-hosted), with load balancing and fallback by priority and weight; translation and auto-align share them. Subtitles in the workspace can be translated into any language (translation only or bilingual); the result is a new subtitle track that reuses the original subtitles' sync result. The old setting is moved into the first profile on upgrade. New tables (migration `0005_llm.sql`), new endpoints, `SubtitleLang`, `ProviderId` gets `translated`, error codes `LLM_NOT_CONFIGURED`, `TRANSLATION_RUNNING`; `Settings.align.llm`, `llmKey`, and `POST /api/admin/align/test` are removed.
- Why: Brian asked for it in the conversation (subtitles are often available only in English; profiles need load balancing and fallback; a floating window, fetching the model list, a test button; translation includes the TMDB summary and is split into chunks with overlapping context lines). He chose the scope from the options.
- Files changed: docs/18-llm.md (new), docs/03-data-model.md, docs/04-api.md, docs/08-media-pipeline.md, docs/11-pages.md, docs/13-settings.md, db/schema.sql, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Downloads page tidy-up

- Before: each row showed only a percentage, no size; there was no summary; the details page could only be reached by clicking the title (not discoverable); on phones the thumbnail took a row of its own; thumbnails with images had an extra colored border.
- Now: a summary next to the heading (how many in each status, total speed, how much is left to download, when everything will finish); the description adds "downloaded / total size"; a "Details ›" button; the progress bar has a moving shine while data is arriving; on phones the thumbnail is on the left; the colored border is fixed; on the details page "Left" reads "about 12 minutes" without repeating "left" (剩), and the progress bar has the moving shine too. See "Downloads (05, 34)" in docs/11-pages.md.
- Why: Brian asked in the conversation for the Downloads page to be improved.
- Files changed: docs/11-pages.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Search box suggests films from TMDB (Chinese titles work too)

- Before: search only asked YTS, which only knows English titles, so searching by a Chinese title found nothing.
- Now: TMDB film suggestions are listed while typing; clicking one uses the IMDb ID to find the same film on YTS and opens it. New endpoints `GET /api/tmdb/suggest`, `GET /api/tmdb/:tmdbId/yts`, `GET /api/tmdb/poster/:file`; the contract gets `TmdbSuggestion`.
- Why: Brian asked for it in the conversation.
- Files changed: packages/shared/src/contracts/api.ts, docs/04-api.md, docs/05-yts.md, docs/11-pages.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Peer map: detect the server's country automatically and center on it

- Before: the server's location was inferred from `TZ` (unrecognized values were treated as Taiwan), and the map was always centered on the prime meridian.
- Now: the country is decided by a vote over the public addresses peers report in the extended handshake (BEP 10 `yourip`), falling back to `TZ` only when none are reported; the map rotates horizontally so that country is in the center. The contract's `TorrentLive` gets `homeFrom`. No external service is asked for the server's own IP.
- Why: Brian asked in the conversation for the system to detect the server's country automatically and move it to the center of the map.
- Files changed: packages/shared/src/contracts/api.ts, docs/06-torrent-worker.md, docs/11-pages.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Sync workbench tools moved below the video

- Before: the video and the subtitle lines were at the top, the timeline in the middle, and the message bar and five tool groups at the bottom; listening to checkpoints meant scrolling up and down. The workspace header had a large poster and a three-line card for choosing subtitles.
- Now: below the video come, in order, the playback bar, the message bar, and the tool tabs (one group at a time, switching to "Checkpoints" automatically when listening to checkpoints); the subtitle lines are on the right, as tall as the left column; the timeline spans the full width below. The video height is limited by the window. The header poster became a thumbnail, the subtitle chooser card became one row, and the step hint and "Confirm sync" share a row. See "Layout" in docs/09-sync-workbench.md.
- Why: Brian said in the conversation that choosing a checkpoint meant scrolling down, then back up to see the video, and asked for more things that could be improved.
- Files changed: docs/09-sync-workbench.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Sources settings split into tabs

- Before: Sources was one long page with nine cards stacked top to bottom.
- Now: three horizontal tabs, "Film data", "Subtitle sources", "Auto-align", with a line of small text under each label describing that tab's status; cards in two columns on wide screens. See "Sources (17)" in docs/11-pages.md.
- Why: Brian said in the conversation that the page was too long and he wanted horizontal tabs.
- Files changed: docs/11-pages.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Confirmation boxes became dialogs

- Before: pressing a destructive action expanded a red confirmation block in the same place (the spec explicitly said not to use a modal).
- Now: a small dialog in the center of the screen (`<dialog>`) with the background dimmed; focus starts on "Not now", Esc or clicking outside cancels, and after closing, focus returns to the original button. Seven pages share the same component and changed together.
- Why: Brian said in the conversation that after pressing "Delete whole film", the red block made that film card taller, and that it was "a really bad design".
- Files changed: docs/11-pages.md, docs/17-ui.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Interface components and colors tidied up

- Before: Chinese headings had no bold on systems without PingFang or JhengHei; status tags and flow tags were outline only; buttons and inputs had different heights; callouts had a thick border all around; the two cards on the Downloads page stuck together; the top bar took three rows on phones; text in the workbench's subtitle lines was centered.
- Now: Noto Sans TC is bundled as the Chinese fallback font (sliced by character range); tags have a light background; buttons and inputs are all 34 px, and the primary button has a light amber background; callouts have a light border plus a colored bar on the left; cards have a very faint shadow; table rows highlight on hover; back links are small gray text; the top bar on phones takes two rows; in the light theme, `--ink-3` is darkened to reach 4.5:1 on the page background too. See docs/17-ui.md.
- Why: Brian asked for it in the conversation ("get the component design and colors right across the whole platform… a lot of places are ugly").
- Files changed: docs/17-ui.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Deleting a whole film also deletes its exports; Export button disabled while exporting

- Before: when the last holder removed a film from their library, the video, preview file and subtitles were deleted but exported MKVs were kept (they outlive the film); the same applied when an administrator force-deleted a video. "Start export" could be pressed repeatedly for the same film.
- Now: when you are the last holder, the Library button is "Delete whole film", and it also deletes all of this film's exports (queued, done and failed ones are deleted directly; ones being packed are cancelled, then deleted); for exports created by someone else, the creator receives `item.deleted`. When someone else still holds the film, it still only leaves. An administrator force-deleting a video also deletes its exports. The confirmation wording lists the exports that will be deleted and the total space freed: the contract's `LibraryItem` and `StorageItem` get `filmExports {count, bytes}`. While this film has a queued or packing export, "Start export" is disabled.
- Why: Brian asked for it in the conversation ("there needs to be a way to delete a whole film from the library, and deleting it should delete the torrent, all the library's subtitles and exports together"; "disable the export button while an export is in progress"). He chose the scope from the options (delete only when you're the only holder, administrators can force it; it replaces the original remove).
- Files changed: packages/shared/src/contracts/api.ts, db/schema.sql (comments), docs/03-data-model.md, docs/04-api.md, docs/10-storage.md, docs/11-pages.md, docs/17-ui.md
- Confirmed by Brian: yes

## 2026-10-06 Align by other subtitles

- Before: auto-align used only the film's audio (speech detection, speech recognition).
- Now: another subtitle track of the same film can be chosen as the reference for alignment. `POST /api/subtitles/:id/auto-align` gets an optional `referenceId`; `AlignResult` gets `reference` (including `offBy`, how far the reference subtitles themselves are from the speech in the film) and `extraLines`, and `method` gets `reference`, `reference-text`, `reference-llm` (the last one doesn't currently occur; it's reserved for later). Credits at the beginning and end are left out of the calculation and listed after alignment so the user can decide whether to delete them; split and merged lines don't affect it.
- Why: Brian asked for it in the conversation (once one subtitle track is synced, it can help sync the others; account for information at the start that isn't part of the film, and one line matching two).
- Files changed: packages/shared/src/contracts/api.ts, docs/04-api.md, docs/08-media-pipeline.md, docs/09-sync-workbench.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Layout: the window doesn't scroll, lists scroll in their own boxes

- Before: the whole page scrolled together.
- Now: the top bar and menu are fixed and the window doesn't scroll; the list on list pages and each table on other pages scroll in their own boxes; on phones the menu becomes a single horizontally swipeable row. The Download details page's map, pieces and speed became tabs; peers get country flags. See "Layout" in docs/17-ui.md.
- Why: Brian asked for it in the conversation (wrap places with lists in containers instead of letting the whole page scroll; use tabs on the details page; add flags). He also reported that "every page can scroll way down, and below is blank", which couldn't be reproduced in Chrome on this machine; with the window no longer scrolling, this can't happen anymore.
- Files changed: docs/11-pages.md, docs/17-ui.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Posters on the Downloads page, and a download details page

- Before: each row on the Downloads page had a block of color on the left, and there was no details page.
- Now: each row has a poster, and the title links to a new "Download details" page: a world map of peers (connections drawn as arcs, like a live cyberattack map), a grid showing the state of each piece, a speed graph, and a peer table. New endpoint `GET /api/torrents/:id/live`, contract `TorrentLive`, table `torrent_live` (migration `0004`), and a DB-IP country lookup table in the image.
- Why: Brian asked for it in the conversation (posters, clicking to see download details, a map showing peers and connections, a grid showing each piece).
- Files changed: docs/03-data-model.md, docs/06-torrent-worker.md, docs/11-pages.md, db/schema.sql, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes (he proposed it); inferring the server location from the time zone, masking half of each IP, and the DB-IP data were my decisions

## 2026-10-06 Film data now comes from TMDB instead of IMDb

- Before: titles, summaries, posters and ratings on Search and the film page all came from YTS (the ratings were IMDb's); TMDB was only used to map IDs and look up Chinese titles.
- Now: with a TMDB key, the Chinese title (shown first), Chinese summary, poster and rating all come from TMDB, the rating states its source, and the film page has "View on TMDB". Without a key it falls back to YTS. The contract gets `MovieSummary.tmdbId`, `ratingSource`, and `MovieDetail.tmdbUrl`. The rating used for filtering and sorting is still YTS's IMDb rating (only it can filter the whole catalog).
- Why: Brian asked for it in the conversation ("use TMDB API, replace imdb") and chose the full scope (ratings, film data, TMDB link, subtitle lookups by TMDB ID).
- Files changed: docs/05-yts.md, docs/11-pages.md, docs/12-auth.md, docs/13-settings.md, packages/shared/src/contracts/api.ts
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Appearance became a single corner button

- Before: appearance was a set of three buttons (Light / Dark / System), placed in the account menu, in Profile, and at the bottom of the sign-in page.
- Now: a single icon button on the right side of the top bar and in the top right corner of sign-in-type pages; each press switches to the next option and the icon spins once. The "Appearance" section was removed from Profile.
- Why: Brian said in the conversation he didn't like three buttons taking up space and wanted one button in the corner that cycles through them.
- Files changed: docs/11-pages.md, docs/17-ui.md
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 The fake subtitle source also answers for the locally seeded film

- Before: docs/15-testing.md said the fake subtitle source only returns results for *Inception* (`tt1375666`). But the film seeded locally on the fake YTS is *Charade* (`tt9000002`), so when the "Offline end-to-end flow" got to finding subtitles, every source returned 0 results, and the same happened in `pnpm dev`; the only option was uploading your own.
- Now: `startFakeSources({ answerAsInception: [...] })` answers for the listed IMDb IDs as if they were *Inception* (TMDB, SubDL, YIFY look up by IMDb; JustSubtitles by the TMDB ID 27205 it looks up). The fake sources in `pnpm dev` and the end-to-end tests both answer for `tt9000002`. The recorded responses are unchanged.
- Why: the phase 9 end-to-end test needs to be able to add subtitles from real search results.
- Files changed: docs/15-testing.md, tools/fakes/src/subtitles.ts, tools/fakes/src/subtitles-cli.ts, scripts/dev.mjs
- Confirmed by Brian: not needed

## 2026-10-06 Auto-align adds speech recognition and a language model

- Before: auto-align looked only at speech detection (two ffsubsync variants, the sync core), and picked wrong on real films with a lot of music (in phase 0, all five Tears of Steel scenarios were wrong).
- Now (the approach Brian specified in the conversation: ASR with Whisper or Qwen, in batches rather than over the whole film, then a language model to align subtitles in a different language):
  - After analysis there is a speech recognition step (faster-whisper `base`, evenly distributed 30-second windows, at most 6 minutes), `media_files.asr_state`, `asr_language`, result `asr.json`. Migration `0002_asr.sql`.
  - Recognized speech is matched with the subtitles: by text comparison for the same language; for different languages by a language model (Claude or an OpenAI-compatible service such as Qwen), called in `api`. The matches are fitted into a new candidate `asr` / `asr-llm`, which also acts as a judge: candidates that contradict the matches are eliminated.
  - New settings `align.asr`, `align.llm.{provider, model, baseUrl}`, new key `llmKey`. `MediaStatus.asr`, `ASR_FAILED` in `MediaErrorCode`, `heard` in `AlignResult`, and two new method names.
  - The image gets `/opt/asr` (about 300 MB).
- Why: Brian's request; measured on Tears of Steel, the five scenarios went from being off by up to 79 seconds to all within 0.03 seconds.
- Files changed: docs/03-data-model.md, docs/04-api.md, docs/08-media-pipeline.md, docs/12-auth.md, docs/13-settings.md, db/schema.sql, packages/shared/src/contracts/api.ts
- Confirmed by Brian: he specified the approach; the details (number of windows, the `base` model, no language model for ranking, calling the language model in api) are not yet confirmed

## 2026-10-06 Cross-site check also accepts requests whose origin matches the host they're sent to

- Before: `docs/12-auth.md` and `docs/04-api.md` required the `Origin` of write requests to be same-origin with `PUBLIC_URL`.
- Now: accepted if `Origin` equals `PUBLIC_URL`, or if the host of `Origin` is this request's `Host`. Invite and reset links still start with `PUBLIC_URL`; but while `PUBLIC_URL` is still `localhost`, the address the administrator currently has the site open at is used instead.
- Why: if `PUBLIC_URL` hasn't been changed to the real address, opening the site by IP from another computer gets even sign-in rejected (Brian wants to test from another device in the morning). A cross-site request carries the attacker site's own Origin, which differs from Host, so the protection is unchanged; the `X-Requested-With` check also stays as is.
- Files changed: docs/12-auth.md, docs/04-api.md
- Confirmed by Brian: no

## 2026-10-06 Export: validation details, `tracks/` when a film is removed, cancellation interrupted by a restart

- Before:
  - docs/04-api.md only listed two errors, `NO_CONFIRMED_SUBTITLE` and `INVALID_FILENAME`, and didn't say what to return for "not exactly one default track", "the same track chosen twice", "subtitles from another film chosen" or "download not finished yet", nor how to distinguish the two explanations for file name errors.
  - docs/03-data-model.md said "`tracks/` of queued exports is deleted by `torrent`; running ones are cleaned up by the packing job itself".
  - "Check once when done" didn't say whether it checks the `.part` file or the renamed file.
  - Nothing said what `media` does when restarted partway through a cancellation.
- Now:
  - Not exactly one default track, same track chosen twice: `VALIDATION` (`details.fields.tracks` is `ONE_DEFAULT`, `DUPLICATE`). Subtitles from another film: `NO_CONFIRMED_SUBTITLE`. Download not finished: `MEDIA_NOT_READY`. File name: `INVALID_FILENAME`, with `details.fields.fileName` being `EXTENSION`, `CHARACTERS`, `TOO_LONG`, matching the two explanations on the page; control characters, a leading dot, and leading or trailing spaces are also rejected (the file name goes into HTTP headers and onto other people's disks).
  - When `torrent` removes a film, it deletes `tracks/` for **every** export it marks as failed (both queued and running); the running packing job deleting it again afterwards isn't an error. That way no orphaned folder is left behind even if `media` happens not to be running.
  - The `.part` file is checked, and renamed only if it passes, keeping "a file visible under its final name is always complete".
  - When `media` starts, exports whose `cancel_requested` is already true are cleaned up directly (delete `tracks/`, delete the row, mark `tasks` as `cancelled`); reconciliation item 4 also cleans up `export` jobs whose target is no longer `queued`/`running`.
  - Exports that have been asked to cancel and are waiting for `media` to stop are not listed, and deleting one again returns `NOT_FOUND`.
  - When an administrator force-deletes a queued export, its `tasks` are also marked `cancelled` and `export.removed` is sent.
  - The space an export needs is defined only in `exportNeedBytes()` in `packages/shared`; `Workspace.exportNeedBytes` and admission use the same one.
- Why: gaps found while implementing phase 7; the behavior follows from the common rules in docs/08 and doesn't change any settled decision.
- Files changed: docs/03-data-model.md, docs/04-api.md, docs/08-media-pipeline.md, docs/10-storage.md, docs/11-pages.md, AGENTS.md (commands)

## 2026-10-06 Subtitle sources: no queue, download moved to api, bsdtar for all three archive types

- Before:
  - `docs/07-subtitle-providers.md` and `docs/02-architecture.md` handed work off through a queue: `subtitle.resolve` put the temporary download URL into the payload of a `subtitle.fetch` job, and `media` downloaded and processed it.
  - zip used a Node library; 7z and rar used tools in the image. SRT and VTT used parsing libraries.
  - When the same source was searched again, all candidates not yet fetched were replaced (a problem recorded in `docs/agent-notes.md`: searching only English would wipe out the Chinese candidates).
  - Nothing said whether `doc_rev` is incremented on confirmation.
- Now:
  - Like the `media` service, there is no queue; the table is the to-do list: `running` rows in `subtitle_searches` are pending searches, and candidates that are `fetching` and don't yet have a temporary folder are pending downloads. `api` has one lane per source and picks up from the table after a restart.
  - **`api` does the downloading**: as soon as it gets the URL it downloads into `/data/tmp/uploads/<candidate id>/`, the same place as uploads (plus a `manifest.json`), and `media` only does the processing (extracting, transcoding, parsing, detecting the language). Uploads and downloads go through the same processing job. `media` no longer needs outbound access.
  - zip, 7z and RAR5 all use `bsdtar`: first list the entries and check the rules, then read only the subtitle files into the program one at a time, counting size while reading, and the program writes the files itself. `bsdtar` doesn't write to disk.
  - SRT and VTT use small parsers written in-house (the rules are simple, and they have tests), with no added dependencies.
  - Searching again only replaces candidates, within the languages this search covers, that haven't been fetched yet or failed to fetch; when the source fails, nothing is replaced.
  - Confirmation doesn't increment `doc_rev` (the document hasn't changed).
  - Auto-align already uses two methods at this phase (ffsubsync plus the sync core), and so does ranking; the calculation lives in `computeAlignment(speech, cues, opts, extraCandidates)`, so later methods (such as speech recognition) only need to supply more candidates.
- Why: Assrt's download URLs are temporary and can't be stored in the table, and without a queue there is nowhere to hold them; having `api`, which has access to the key, download directly is simplest. `bsdtar` was already verified on all three formats in phase 0, and one approach with one set of checks is better than two; having it output only to stdout means paths and symlinks never get a chance to land on disk. The language scope of replacement was a defect found during cross-checking.
- Files changed: docs/02-architecture.md, docs/03-data-model.md, docs/07-subtitle-providers.md, docs/10-storage.md, docs/15-testing.md
- Confirmed by Brian: no (Handover level)

## 2026-10-06 media service: no pg-boss, one error slot per asset, tests run in the image

- Before: `docs/02-architecture.md` used pg-boss as the job queue; `media_files.error` and `MediaStatus.error` had only one slot.
- Now:
  - `media` claims jobs directly from the tables: waiting rows are the to-do list, and a conditional update claims them, so a job queued twice runs only once; on restart, "running" is changed back to "waiting" and then reconciled. Each of the three kinds of job (analysis, preview assets, recalculating usage) runs only one at a time.
  - `media_files.error` stores `{analysis?, audio?, proxy?}`, and the contract changes to `MediaStatus.errors`. A later preview file failure no longer overwrites "why there is no waveform".
  - Tests that need ffmpeg and ffsubsync (`apps/server/test/media.test.ts`) are explicitly skipped when the host doesn't have those tools; `pnpm test:image` actually runs them in the image.
- Why: the spec already treated the tables as the source of truth, and the queue was only "telling someone to do something"; with one less system, deduplication and restart behavior are also easier to verify. The single error slot was a spec defect found during cross-checking.
- Files changed: docs/02-architecture.md, docs/03-data-model.md, docs/04-api.md, docs/08-media-pipeline.md, docs/09-sync-workbench.md, docs/11-pages.md, packages/shared/src/contracts/api.ts, db/schema.sql (comments)
- Confirmed by Brian: no (Handover level)

## 2026-10-06 The Overview's DISK_LOW threshold, media service heartbeat

- Before: `docs/11-pages.md` had a `DISK_LOW` issue, but neither 10 nor 13 set a threshold; the `media` service didn't write a heartbeat before its own phase.
- Now: it's listed as an issue when the disk's own free space is less than twice the system reserve (default 4 GB). The `media` service writes a heartbeat now (even though it has no work yet); otherwise the Overview would keep saying it isn't responding. The System status page isn't built yet, so issues in the Overview that point to it (`SERVICE_DOWN`, `FAILED_TASK`) don't show a button yet.
- Why: needed when building the Overview; the threshold is twice the system reserve because below one times, admission already rejects, and at two times there's still time to deal with it.
- Files changed: docs/11-pages.md, docs/13-settings.md
- Confirmed by Brian: no (a Handover-level detail)

## 2026-10-06 Phase order: sign-in, search and downloads first

- Before: `docs/14-plan.md` went in order through phase 1 (accounts and shell) → 2 (search and film page) → 3 (downloads and storage limit).
- Now: on 2026-10-06 Brian said to do YTS search and torrent downloading first, with sign-in. So this round did phase 1's sign-in, shell and shared code, all of phase 2, and most of phase 3. What's not done yet is listed in `docs/reports/phase-1-3.md` (invites, registration, password reset, Profile, user management, the Activity log page, force delete, the `media` code, etc.).
- Why: Brian's instruction (item 1 of "Order of authority" in AGENTS.md).
- Files changed: the plan itself wasn't changed; this entry is a record
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Appearance can be light, dark or system

- Before: `docs/17-ui.md` only followed the system, and `data-theme` was only for tests.
- Now: the account menu, Profile and the sign-in page have a three-way choice, stored in the device's localStorage; `public/theme-init.js` applies it before the first paint.
- Why: Brian's UI principles (2026-10-06): it must be responsive, and Light, Dark and System must be selectable.
- Files changed: docs/17-ui.md, docs/11-pages.md (shell, sign-in, Profile)
- Confirmed by Brian: yes (he proposed it)

## 2026-10-06 Database: plain SQL migrations, no Drizzle

- Before: `docs/02-architecture.md` chose Drizzle ORM, and phase 1 in `docs/14-plan.md` called for defining the schema in Drizzle, generating migrations, and writing a test confirming it is equivalent to `db/schema.sql`.
- Now: migrations are plain SQL files, and the first one (`apps/server/migrations/0001_init.sql`) is the handed-over `db/schema.sql`. Queries use `pg` with hand-written SQL, wrapped in each domain's own functions. The equivalence test is still done (`apps/server/test/schema-equivalence.test.ts`: build a database from each side and compare columns, constraints, indexes, functions and views).
- Why: there is already a written and tested SQL schema; rewriting it in Drizzle would mean keeping two copies consistent, and usage calculation, admission and queuing need direct SQL anyway. The technology choices in 02 aren't among the decisions in 00.
- Files changed: docs/02-architecture.md
- Confirmed by Brian: no (a Handover-level technology choice, explained in the report)

## 2026-10-06 Incoming connections only look at TCP

- Before: `docs/06-torrent-worker.md` treated both `tcpIncoming` and `utpIncoming` as "the port is open".
- Now: only `tcpIncoming` counts.
- Why: in phase 0, `utpIncoming` showed up even without confirmed router forwarding (UDP connecting back through NAT), which would mislead an administrator into thinking the port was open. D32 is at the "Handover" level.
- Files changed: docs/06-torrent-worker.md
- Confirmed by Brian: not needed

## 2026-10-06 Contracts and the sync core moved into packages/shared

- Before: `contracts/api.ts`, `reference/sync-core/core.ts` and its tests were where the handover pack put them.
- Now: `packages/shared/src/contracts/api.ts`, `packages/shared/src/sync-core/` (`git mv`, only one copy kept). The tests changed from `node:test` to Vitest: only the source of `test` and the relative paths to fixtures changed; the cases and expected values are untouched (`node:assert` is still used).
- Why: the first step of phase 1 in `docs/14-plan.md`. On 2026-10-06 Brian asked for sign-in, YTS search and downloading first, which all need the contract types, so it was done early.
- Files changed: every place in the repo that mentioned the old paths (AGENTS.md, README.md, docs/, fixtures/README.md, prototype/README.md, reference/, comments in db/schema.sql, scripts/phase0/). The paragraph in `docs/14-plan.md` describing this move and `docs/reports/phase-0.md` are records and keep the original paths
- Confirmed by Brian: not needed

## 2026-10-05 Can Playwright's Chromium decode H.264?

- Before: docs/15-testing.md, 08, 09, fixtures/README.md and prototype/README.md said "Playwright's built-in Chromium can't decode H.264".
- Now: the version at handover couldn't; Playwright 1.63 (Chromium 153) was tested and can. Tests still use WebM, with the reason changed to "not depending on this".
- Why: tested in phase 0 item 7: an H.264 High + AAC MP4 (stereo and 5.1, `moov` at the end of the file) plays and seeks, and the frames are actually decoded.
- Files changed: docs/08-media-pipeline.md, docs/09-sync-workbench.md, docs/15-testing.md, fixtures/README.md, prototype/README.md
- Confirmed by Brian: not needed

## 2026-10-05 Default tracker list

- Before: docs/05-yts.md listed four trackers written from memory.
- Now: only `tracker.opentrackr.org:1337` and `open.demonii.com:1337` are kept.
- Why: tested in phase 0 item 5: `tracker.openbittorrent.com` has no DNS record, and `p4p.arenabg.com:1337` times out. Check again against the list in the YTS API docs once the YTS URL is available.
- Files changed: docs/05-yts.md
- Confirmed by Brian: not needed

## 2026-10-05 JustSubtitles: missing IDs return 200, shape of title search

- Before: docs/07-subtitle-providers.md said a nonexistent ID returns HTTP 500, and the outer fields of title search were "not recorded".
- Now: a nonexistent ID is handled the same whether it returns 200 or 500 (look at `status: false` in the body, not the status code); title search returns `{results: [...]}`, each item in the shape of a TMDB movie search result, films only.
- Why: results of actual server-side calls in phase 0 item 4. It was also confirmed that every `url` in `ZH` and `ZH_BG` carries someone else's `api_key`, and downloads still succeed with it removed.
- Files changed: docs/07-subtitle-providers.md, reference/providers/ (replaced with recorded real responses)
- Confirmed by Brian: not needed

## 2026-10-05 Archive test fixtures

- Before: fixtures/README.md said "there are no `.rar`, `.7z` or malicious archives yet; prepare them in phase 0".
- Now: `fixtures/archives/` has RAR5 and 7z, plus seven archives that should be rejected (path escape, absolute path, symlink, bomb, more than 200 entries, no subtitles, corrupted file), generated by `scripts/phase0/make-archives.sh`.
- Why: phase 0 item 3. There is no RAR4 sample: the current `rar` 7 can no longer write RAR4.
- Files changed: fixtures/README.md, fixtures/archives/
- Confirmed by Brian: not needed

## 2026-10-05 Example files in deploy became real files

- Before: `deploy/Dockerfile.example`, `docker-compose.example.yml`, `Caddyfile.example`, never built.
- Now: `deploy/Dockerfile`, `docker-compose.yml`, `Caddyfile`. Changes after actually building them:
  - The three server services share one image tag, `paiban-server`, and compose builds it only once (before, it built three images with the same content and different IDs).
  - `pnpm deploy` needs `--legacy` (required by pnpm 12 when inject-workspace-packages isn't enabled); the build phase also copies `tsconfig.base.json`.
  - `apps/server` puts only `dist/` into the image.
  - `.env.example` notes that `DATA_PATH` must be created first: if it doesn't exist, Docker creates it as root, and the three services, which run as `PUID`, can't write to it (this actually happened).
  - The page's `<title>` is filled in from `SITE_NAME` at build time (D9).
- Why: phase 0 item 1.
- Files changed: deploy/, docs/12-auth.md (file names), docs/02-architecture.md (ffmpeg version)
- Confirmed by Brian: not needed
