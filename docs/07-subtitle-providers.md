# 07 Subtitle sources

Four sources plus user uploads, **all done in the same phase** (D5). Within the phase, JustSubtitles comes first, because it matters most and because it walks the whole path (search → download → extract → convert encoding → detect language); the other sources only swap in a different way of getting the list.

| Source | Method | Looked up by | Settings needed |
| --- | --- | --- | --- |
| JustSubtitles | The JSON interface its website uses; fallback is the official SubDL API | TMDB ID | TMDB key recommended; fallback mode needs a SubDL key |
| YIFY Subtitles | Parse web pages | IMDb ID | None |
| Assrt (Shooter) | Official API | Title keywords | API token |
| Zimuku | Assisted: only gives a link; the user downloads and then uploads | Title | None |
| Upload | The user drags files in | | None |

The per-source details in this document were verified on 2026-10-04. **Third-party sites can change at any time.** Item 4 of Phase 0 records one real response from each source and checks it against what is written here; on any mismatch, update this document and the samples in `reference/providers/`.

## Common rules

These rules apply to every source. Implement them as a shared HTTP client; don't write a separate one per source.

- **Only connect to allowed hosts.** Each source has a host list (given in each section below). A download URL given in a source's response is not fetched if its host is not on the list. Nor are hosts whose resolved IP is private, loopback or link-local. At most 3 redirects, each checked again. (In development and testing, `ALLOW_LOCAL_SOURCES` and `SOURCE_OVERRIDES` swap these hosts for fake sources, see [15-testing.md](15-testing.md); the host list itself is still checked.)
- **Timeout 10 seconds** (30 seconds for file downloads). **Response size limits**: 2 MB for JSON and HTML, 20 MB for subtitle files.
- **`User-Agent: Paiban/<version>`**; never pose as a browser.
- **Never bypass any mechanism that blocks automated access** (D27). On a CAPTCHA page, a challenge page, or a response that is clearly not the expected content, mark the source `BAD_RESPONSE` and stop. No retries, no changing headers, no imitating a browser.
- **Key hygiene** (D28):
  - Put our own keys and tokens in headers rather than URLs whenever possible. When they have to go in the URL (SubDL, TMDB v3), strip the whole query string before logging.
  - Any key belonging to someone else that appears in a response (for example, JustSubtitles' `url` sometimes carries `?api_key=…`) is dropped **at the moment of parsing**: keep only the path when reading `url`. Never store, log or use it. This needs a unit test.
- **One source failing doesn't affect the others.** Each source's results and errors are written to `subtitle_searches` separately, and each emits its own events.
- **Caching** lives in `provider_cache`, valid for the setting `providers.cacheHours` (default 24 hours, 1 to 168). It stores the **parsed** result (a list of `FoundSubtitle`), not the source's raw response; the raw response may carry someone else's key, the parsed one won't. When the user presses "Search again" or "Retry", the cache is skipped (`refresh: true`).
- **Per-source request queue** (D41): for a given source, no matter which program sends the request (currently both lookups and downloads are sent by `api`, but the rule doesn't depend on that), consecutive requests are spaced at least a minimum interval apart: 1 second for JustSubtitles (including SubDL) and YIFY Subtitles, 3.4 seconds for Assrt (fewer than 18 a minute). Because requests come from two programs, this queue lives in the database: before sending a request, call `select provider_take_slot('<source>', <milliseconds>)`; it returns "the time you may send", and you wait until then (`db/schema.sql`, tested). TMDB and YTS don't use this queue.

### Interface

```ts
interface SubtitleProvider {
  id: 'justsubtitles' | 'yify' | 'assrt';
  hosts: string[];                                    // allowed hosts (suffix match allowed)
  search(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]>;
  /** Returns URLs that can be downloaded now. Some sources' download URLs are temporary, so resolve them right before downloading. */
  resolveDownload(ref: string): Promise<{ url: string; fileName?: string }[]>;
  /** Returns codes and data, not sentences. SourceCheck is defined in packages/shared/src/contracts/api.ts. */
  test(): Promise<SourceCheck>;
}

type FilmContext = {
  imdbCode: string; tmdbId: number | null;
  title: string; titleZh: string | null; year: number;
  release: { quality: string; source: string; videoCodec: string };   // the downloaded version
};

type FoundSubtitle = {
  ref: string;                 // stable ID within this source
  languageLabel: string;       // the source's own wording, kept as is
  language: DetectedLang;      // our guess
  releaseName: string; uploader: string | null; pageUrl: string | null;
  hearingImpaired: boolean; rating: number | null;
};
```

### Who does which step

Outbound lookups need keys, which only `api` can decrypt, so the work is split like this:

| Step | Queue | Who | What it does |
| --- | --- | --- | --- |
| Lookup | `subtitle.search` | api | One job per source per film. Calls `search`, writes the results to `subtitle_candidates` and `subtitle_searches`, `NOTIFY` (`candidates`) |
| Resolve the download URL and download | `subtitle.resolve` | api | One job per candidate. Calls `resolveDownload`, downloads right away, writes the files plus a `manifest.json` (each file's original name) to `/data/tmp/uploads/<candidate id>.part/` first, checks that the candidate is still being fetched and the film is not being deleted, then renames it to `/data/tmp/uploads/<candidate id>/`, `NOTIFY paiban_media`. The URL is kept only in memory, never stored in a table or written to the log. If the URL can't be resolved or the download fails, the candidate is marked failed (`DOWNLOAD_FAILED`), and `NOTIFY paiban_media` so the ranking progress updates too |
| Processing | `subtitle.fetch` | media | Extract, convert to a list of lines (see "Download and processing"). When done, `NOTIFY paiban_events` (`candidates`); candidates waiting to be ranked (`align_state = 'queued'`) are then aligned by `subtitle.rank` |
| Uploaded files | `subtitle.ingest` | media | Same job as the previous step: uploaded files are also placed in `/data/tmp/uploads/<candidate id>/` |

Making lookups jobs rather than calling them directly in the request has two benefits: the endpoint can respond immediately, and when `api` restarts the jobs are dispatched again, so no source is left stuck at "Searching…" forever.

As with `media`, these jobs have no separate queue; the tables themselves are the to-do list (a change on 2026-10-06, see [changes.md](changes.md)): `subtitle_searches` rows with `state = 'running'` are lookups to do; candidates with `fetch_state = 'fetching'` and no temp folder yet are waiting to be downloaded; those with a temp folder are waiting for `media` to process them. `api` has one lane per source, which handles that source's lookups and downloads in order, so one slow source doesn't hold up the others; on startup `api` picks up from the tables. Downloads are done by `api` rather than `media` because Assrt's download URLs are temporary, can't be stored in a table, and there is no queued job payload to hold them in.

These four kinds of short jobs don't go through the "Waiting → Running" claim (the "claim first" rule in [08-media-pipeline.md](08-media-pipeline.md) is for jobs that have `tasks`): their only state is "in progress". The other rules still apply, especially the four in "What happens when a download is deleted" in [03-data-model.md](03-data-model.md): don't start work for a film that is being deleted, check once more before writing files, and make the final update's condition include that the download's `want` is not `remove`. Duplicates are prevented by two things: each lane does one thing at a time, and each job first checks that its row still needs it (the source is still `running`, the candidate is still `fetching`) and simply ends if not. Doing the work twice is harmless anyway: results are prepared in a working directory, and only one of the final conditional updates succeeds (the lookup's update compares the start time, so an old lookup replaced by a newer search can't write); the other discards what it prepared.

Lookup jobs don't retry automatically: on failure the source is recorded as `error`, and the user presses "Retry". The only exception is Assrt's quota limit (see its section): that lookup job postpones itself until the time it may retry and runs once more, just once.

When the two kinds of jobs handled by `api` finish, they emit the `candidates` event directly; the two handled by `media` use `NOTIFY`.

## Languages

On the Subtitles tab, the user picks the languages to look for (繁體中文 Traditional Chinese, 简体中文 Simplified Chinese, English); the defaults come from Profile.

**The language a source labels is only a hint.** In practice, Traditional subtitles are often filed under Simplified and vice versa. So:

- Widen the search: when looking for Traditional Chinese, query all of the source's Chinese categories.
- The candidate list shows both our guess and the source's original label (the prototype does this: "繁體中文 `ZH_BG`").
- After the file is downloaded, **detect again from the content** (see "Download and processing"), and the language in the list updates accordingly.
- When adding, if the content is Simplified and the user's preference is "Convert Simplified Chinese subtitles to Traditional automatically", convert it.

| Ours | Meaning |
| --- | --- |
| `zh-Hant` | Traditional Chinese |
| `zh-Hans` | Simplified Chinese |
| `zh` | Chinese, but not yet sure whether Traditional or Simplified (file not downloaded yet, or content too short) |
| `en` | English |
| `und` | Can't tell |

## JustSubtitles

### What it is

JustSubtitles' website front end requests data from its own JSON interface, which needs no sign-in. The subtitle data comes from SubDL, and files are downloaded from SubDL's download host too. The website's interface shows no Chinese, but the interface can query it.

This interface has no public documentation and can change at any time. So there are two modes (setting `providers.justsubtitles.mode`):

| Mode | How | When to use |
| --- | --- | --- |
| `direct` (default) | Use JustSubtitles' interface | Normally |
| `subdl` | Use the official SubDL API, same set of subtitles | When `direct` breaks; switched by an administrator. Needs a SubDL key the administrator applies for |

Both modes return the same fields for each subtitle, so they share one parsing function.

Allowed hosts: `www.justsubtitles.com`, `api.justsubtitles.com`, `search.justsubtitles.com`, `api.subdl.com`, `dl.subdl.com`.

### Lookup (`direct`)

```
GET https://www.justsubtitles.com/api/subtitles/<TMDB ID>?lang=<language code>
```

(`https://api.justsubtitles.com/api/subtitles/<id>?lang=…` returns the same thing; kept as a backup.)

| Fact | Consequence |
| --- | --- |
| The ID **only accepts TMDB IDs**. An IMDb ID returns 0 results | IMDb IDs must first be turned into TMDB IDs, see the next subsection |
| `lang` is one at a time: `EN`, `ZH`, `ZH_BG` | One request per language |
| At most 30 results per language; the `page` parameter has no effect | Results past the 30th can't be reached. English subtitles for popular films get cut off |
| When the ID doesn't exist, the body is `{"status":false,"subtitles":[]}`. On 2026-10-04 a browser saw **HTTP 500**; on 2026-10-05 Phase 0 got **HTTP 200** from the server side | Treat both as "no results", not an error. Decide by the body, not the status code: the response is JSON and `status` is false (whether the status code is 200 or 500) |
| The response carries `cache-control: public, max-age=86400` | We cache for 24 hours too |
| It responds to requests not sent by a browser; robots.txt has no restrictions | |

Language mapping:

| Looking for | Which `lang` to query | Source's label |
| --- | --- | --- |
| English | `EN` | `english` |
| 繁體中文 (Traditional Chinese) | Query both `ZH_BG` and `ZH` | `big_5_code`; `chinese-bg-code` |
| 简体中文 (Simplified Chinese) | `ZH` | `chinese-bg-code` |

`ZH_BG` is SubDL's "Big 5 code", nominally Traditional; `ZH` is "Chinese BG code", nominally Simplified. For *Inception*, the lookup returned 30 for `EN`, 7 for `ZH` and 3 for `ZH_BG`, and `ZH` included Traditional subtitles with `.cht` in the file name. The first file Phase 0 downloaded from `ZH` was Traditional (`.hk.srt`, UTF-8).

**Other people's keys really do show up**: in the responses recorded in Phase 0, **every** `url` under `ZH` and `ZH_BG` carried `?api_key=…`, and none under `EN` did. With the query string removed, downloading from `dl.subdl.com` still succeeded (200, `application/zip`), so that key is neither needed nor used.

Response (sample in `reference/providers/justsubtitles.subtitles.sample.json`):

```json
{ "status": true,
  "subtitles": [ { "release_name": "…", "name": "…", "lang": "english", "language": "EN",
                   "author": "…", "url": "/subtitle/3467330-8390389.zip", "subtitlePage": "…",
                   "hi": false, "season": 0, "episode": null, "framerate": null, "fps": null,
                   "episode_from": null, "episode_end": 0, "full_season": false } ] }
```

| Field | Use |
| --- | --- |
| `url` | **Take only the path** (`/subtitle/<number>-<number>.zip`); drop the query string. Skip the entry if the path doesn't match this pattern. This path is also the `ref` |
| `release_name` | Release name, for display and for deciding whether it matches the downloaded version |
| `language` | Language code; map from this, not from `lang` (text, inconsistent format) |
| `author` | Uploader |
| `hi` | Hearing impaired |
| `subtitlePage` | Appended to `https://www.justsubtitles.com` as the link to the source page |
| Others | For TV series; ignored |

### Download

```
GET https://dl.subdl.com<path from url>
```

The response is `application/zip`. No parameters or key needed.

### Turning IMDb IDs into TMDB IDs

YTS gives IMDb IDs. Try in order:

1. This film has been looked up already (`movies.tmdb_id` or the cache): use it directly.
2. **With a TMDB key**:
   ```
   GET https://api.themoviedb.org/3/find/<IMDb ID>?external_source=imdb_id&language=zh-TW
   ```
   Take `movie_results[0].id`, and store `title` as the Chinese title while at it (not stored if it equals the original title). If the key looks like a v4 read access token (long, with two dots), send it as `Authorization: Bearer`; otherwise it's a v3 key, sent as the `api_key` parameter (stripped when logging). Cache the result for 30 days.
3. **Without a TMDB key** (D38): use JustSubtitles' own title search
   ```
   GET https://search.justsubtitles.com/api/search?q=<title>
   ```
   The response is `{"results": [...]}`, each entry in the shape of TMDB's "search movie": `id`, `title`, `original_title`, `release_date` (`YYYY-MM-DD`, may be null), `original_language` and so on (sample in `reference/providers/justsubtitles.search.sample.json`, recorded in Phase 0). Results are only films and have no `media_type` field, so "is a film" needs no separate check. Use an entry's `id` only when the title (or original title) is an exact case-insensitive match and the year of `release_date` equals the YTS year. If several match or none do, give up. Looking up *Inception* returns two entries with exactly the same title (2010 and 1980), so the year condition is necessary.
4. All fail: this source reports `NOT_CONFIGURED`, with a message pointing the administrator to set a TMDB key. Other sources are unaffected.

### Fallback mode (`subdl`)

```
GET https://api.subdl.com/api/v1/subtitles?api_key=<key>&imdb_id=<tt…>&type=movie&languages=EN,ZH,ZH_BG&subs_per_page=30
```

- Uses the IMDb ID directly; no TMDB needed.
- `subs_per_page` is at most 30.
- The free quota is 2,000 requests a day. Its two documents disagree on the download limit (300 or 50 per IP per day); go by what actually happens.
- Each entry in the response's `subtitles` array has the same fields as above; downloading works the same way.
- The key is in the URL, so this source's requests are always logged without the query string.

### Test connection

The two modes are two separate tests on the Sources page (`POST /api/admin/sources/justsubtitles/test` and `…/subdl/test`), and either can be tested regardless of which mode is in use:

| Test | What it does | Result |
| --- | --- | --- |
| `justsubtitles` | Uses the `direct` interface to look up English subtitles for TMDB ID 27205 | `OK` with `{count}`; response not in the expected shape: `BAD_RESPONSE`; can't connect: `UNREACHABLE` |
| `subdl` | Uses the official API to look up `imdb_id=tt1375666` | `OK` with `{count}`; no key: `NOT_CONFIGURED`; key rejected: `INVALID_KEY`; over quota: `RATE_LIMITED` |

TMDB's test (`…/tmdb/test`): call find for `tt1375666`. Results: `OK`; no key: `NOT_CONFIGURED`; a 401: `INVALID_KEY`.

## YIFY Subtitles

No API; parse the server-rendered web pages. The URL is the setting `providers.yify.baseUrl` (default `https://yts-subs.com`).

Allowed hosts: the configured host, `subtitles.yts-subs.com` (and the `subtitles.` subdomain of the configured host).

### Lookup

```
GET <base>/movie-imdb/<IMDb ID>
```

The page has a table whose columns are, in order, Rating, Language, Release, Uploader, Download. Each row has a link to `/subtitles/<slug>` (each row has two links to the same slug; deduplicate), and `<slug>` is the `ref`. The page for *Inception* has 402 rows (English 147, Chinese 6, Big 5 code 2, Chinese BG code 2, the rest other languages). The whole page is about 290 KB, within the 2 MB limit.

- Find it by structure ("the table with these five column headers"); don't rely on class names. Sample in `reference/providers/yify.movie-page.sample.html`.
- Keep only rows in the languages being looked for; drop the rest.

| Language in the table | Our guess |
| --- | --- |
| `English` | `en` |
| `Chinese` | `zh` (Traditional or Simplified unknown) |
| `Big 5 code` | `zh-Hant` |
| `Chinese BG code` | `zh-Hans` |

When looking for Traditional Chinese, list all three kinds of Chinese.

### Download

1. `GET <base>/subtitles/<slug>`
2. Find `a#btn-download-subtitle`; its `data-link` attribute is base64 that decodes to the zip URL: `https://subtitles.yts-subs.com/subtitles/<slug>.zip`
3. If the decoded URL's host is not on the allowed list, give up.
4. Download the zip.

If the button can't be found, or `data-link` doesn't decode to a URL, **don't guess URLs and try them**. Mark the entry as download failed (`DOWNLOAD_FAILED`) and record the source's status as `BAD_RESPONSE`: the page structure has very likely changed and needs a person to look.

### Test connection

Fetch the page for `tt1375666`. Rows parsed: `OK`, with `data` of `{rows: row count}`. 0 rows parsed while the page is not a 404 means the layout changed: `BAD_RESPONSE`. Can't connect: `UNREACHABLE`.

## Assrt (Shooter)

Official API, documented at `https://assrt.net/api/doc`. Needs a token (the administrator gets it from the user panel after signing up at Assrt).

Allowed hosts: `api.assrt.net` (backup `api.makedie.me`), plus the hosts of download URLs in API responses; the latter are limited to subdomains of `assrt.net`. If another domain actually shows up, log it and don't connect; a person then decides whether to add it to the list.

### Limits

- **20 per minute per token plus IP.** Our queue interval is set to 3.4 seconds, i.e. fewer than 18 a minute (see "Common rules").
- Going over returns error code `30900`. On receiving it, push this source's next allowed send time back 60 seconds (set `provider_slots.next_at` to 60 seconds later), mark the source status `RATE_LIMITED` with the expected retry time (`retryAt`), and retry automatically once when the time comes. Interface wording follows the prototype: the source label on the Subtitles tab reads "Over the limit of 20 a minute", with "Retry" next to it; the source status on the admin page reads "Over the limit of 20 a minute; postponed automatically".
- The token is sent in the `Authorization: Bearer <token>` header, not in the URL.
- **The terms of use require credit.** Everywhere Assrt results are shown must have "Subtitles provided by assrt.net" and a link to `https://assrt.net`. The API gives the name and URL in `ProviderStatus.credit` (`{name: 'assrt.net', url: 'https://assrt.net'}`); the front end writes the sentence.

### Lookup

```
GET https://api.assrt.net/v1/sub/search?q=<keywords>&cnt=15&pos=0
```

- `q` is at least 3 characters. `cnt` is at most 15.
- There are also three parameters, `is_file`, `no_muxer` and `filelist`; their exact meaning is as in the official documentation; the first version doesn't use them.
- It's a keyword search, not by ID, so other films get mixed in. Approach:
  1. Search `<English title> <year>`.
  2. If there is a Chinese title (from TMDB), search the Chinese title as well.
  3. Deduplicate the two result sets by `id`.
  4. Keep only results whose `videoname` or `native_name` contains the year, or the title (punctuation removed, case-insensitive).
- One film uses at most 2 lookups of quota.

Result fields (sample in `reference/providers/assrt.search.sample.json`):

| Field | Use |
| --- | --- |
| `id` | `ref` |
| `videoname` | Release name. Use `native_name` when empty |
| `native_name` | Title |
| `lang.desc` | The source's language description, used as is for `languageLabel` |
| `lang.langlist` | An object whose keys show which languages are present: `langcht` Traditional, `langchs` Simplified, `langeng` English, `langdou` bilingual (key names from memory; go by the actual response). If Traditional is present, guess `zh-Hant`; only Simplified, guess `zh-Hans`; only English, guess `en` |
| `subtype` | Format description. Anything containing `VobSub` is image-based subtitles: **skip** |
| `release_site`, `vote_score`, `upload_time` | Display and sorting |

### Download

```
GET https://api.assrt.net/v1/sub/detail?id=<id>
```

The response adds `filename`, `url` (download URL for the whole package) and `filelist` (separate download URLs for each file in the archive: `f` is the file name, `s` the size, `url` the URL).

- **Prefer `filelist`**: pick the entries with subtitle extensions, one URL per file, no extraction needed. Many Assrt files are RAR, and this avoids them.
- Only download `url` and extract it when `filelist` is empty.
- These URLs are temporary, so `resolveDownload` is called only right before the actual download, and the URLs are kept only in the job's payload, never stored in `subtitle_candidates.download_url`.
- Each fetch uses one lookup of quota. "Auto-align and rank them all" fetches many entries, so Assrt's candidates appear slowly, one at a time; that is normal.

### Error codes

| Code | Meaning | What we do |
| --- | --- | --- |
| `1` | User doesn't exist | `NOT_CONFIGURED` |
| `101` | Keyword shorter than 3 characters | Shouldn't happen; skip that lookup |
| `20000` | Missing parameter | `BAD_RESPONSE` |
| `20001` | Invalid token | `NOT_CONFIGURED` |
| `20400` | Endpoint doesn't exist | `BAD_RESPONSE` |
| `20900` | Subtitle not found | Mark that entry as download failed |
| `30000`, `30001`, `30002`, `30300` | Server, database, search or API temporarily unavailable | `UNREACHABLE` |
| `30900` | Over quota | `RATE_LIMITED`, see above |

### Test connection

Call `GET /v1/user/quota`. Success is `OK`, with `data` of `{quota: remaining quota}`; no token is `NOT_CONFIGURED`; invalid token (`20001`) is `INVALID_KEY`.

## Zimuku (assisted)

Zimuku blocks automated access with a CAPTCHA, so **the system never connects to it** (D27).

- The setting `providers.zimuku.enabled` decides whether the Subtitles tab shows this card.
- The setting `providers.zimuku.searchUrl` is a URL template containing `{q}`. Its domain also changes often, so there is **no default**; an administrator fills in one that currently works. If it's empty, the button isn't shown.
- The button opens `searchUrl` in a new tab, with `{q}` replaced by "title year" (the Chinese title if there is one). The link carries `rel="noopener noreferrer"`.
- The card lists two steps: open the search page, pass the check and download the archive; drag the archive onto the upload area.

## Upload

- Accepts `.srt`, `.ass`, `.ssa`, `.vtt`, `.zip`, `.rar`, `.7z`, up to 20 MB. (Following the prototype, the interface text lists only `.srt`, `.ass`, `.vtt`; `.ssa` is accepted too, just not mentioned.)
- `api` first saves the file to `/data/tmp/uploads/<random name>.part/`, computes its sha256, **creates a candidate on the spot** (`provider = 'upload'`, `provider_ref` is the sha256, `release_name` is the file name, `fetch_state = 'fetching'`), then renames the folder to `/data/tmp/uploads/<candidate id>/`, `NOTIFY paiban_media`, and returns the candidate list immediately. The user sees a "Processing…" row right away.
- Further processing is exactly the same as for files downloaded from sources. When an archive contains several subtitle files, the original candidate becomes one of them and a new candidate is added for each of the rest.
- If processing succeeds, the row can be "Add"ed. If it fails, the row shows the reason (`fetchError`) and "Remove" (`DELETE /api/candidates/:id`). That way an unreadable file doesn't silently disappear.
- Uploading the same file again: no extra row. If it was processed already, it's returned as is; if it failed last time, it's processed again.

## Download and processing (`subtitle.resolve` downloads; `subtitle.fetch` / `subtitle.ingest` process)

Wherever a file comes from, it goes down the same path. The reference implementation is in `reference/subtitles/text.mjs`, and the test fixtures are in `fixtures/`.

1. **Download** (skipped for uploads; done by `api`, see "Who does which step"): first take a slot in the queue, then do the host check, size limit and timeout. If it can't be fetched, that's `DOWNLOAD_FAILED`.
2. **Decide whether it's an archive**: look at the file header, not the extension.
3. **Extract** to `/data/tmp/work/<job>/`, with these limits; breaking any one rejects the whole package (`ARCHIVE_INVALID`):
   - At most 200 entries; no more than 50 MB extracted in total; no single file over 10 MB
   - Entry paths can't be absolute, can't contain `..`, and can't be symbolic links
   - Can't be opened or corrupted format is also `ARCHIVE_INVALID`
   - Take only `.srt`, `.ass`, `.ssa`, `.vtt`; ignore everything else (`.sub`/`.idx`, `.txt`, `.nfo`, `__MACOSX/`)
   - Opens but contains no subtitle file at all: `NO_SUBTITLE`
   - All three formats use `bsdtar` from the image (libarchive 3.7.4; Phase 0 verified it extracts zip, 7z and RAR5; no RAR4 sample). It sets no limits for us on its own, so: first list the entries with `bsdtar -tf` / `-tvf` and check them against the rules above (declared sizes count too); once they pass, take only the subtitle files, reading them one by one into the program with `bsdtar -x -O`, counting the actual bytes while reading (headers can lie), and the program itself writes them into the working directory under fixed file names. `bsdtar` never writes to disk, so the paths and symbolic links inside the archive never get a chance to land
4. **Convert to text**: check in order BOM → strict UTF-8 → try Big5, GB18030, Shift_JIS, EUC-KR, Windows-1252 and take whichever decodes most like a language. Record the original encoding.
5. **Parse into lines**: SRT and VTT use our own small parser (simple format: the `-->` timing line, an optional number, skipping VTT's `NOTE`/`STYLE` blocks and the settings after the timing; covered by tests); for ASS, take only `Dialogue`, strip drawing commands and style tags, and turn `\N` into a line break (D34).
6. **Normalize**:
   - Unify line breaks to `\n`, trim whitespace at the start and end of each line, drop lines with no text
   - Clamp negative times to 0; for lines whose end is not later than the start, set the end to 1 second after the start
   - Sort by start time and renumber 1 to n (this number is `Cue.id`, the key the sync doc's per-line edits use)
   - Leave the text content alone (tags like `<i>` in SRT are kept and written back as is on export; they're handled when displayed on screen)
   - Not a single line is a failure (`PARSE_FAILED`)
7. **Detect the language** (from content): enough Chinese characters means Chinese, then compare with Traditional/Simplified conversion to see which kind of characters dominates; otherwise check whether it's English.
8. **Write files**: in the working directory, prepare `original.<ext>` (original bytes) and `cues.json` (list of lines), check that the film isn't being deleted, then move the whole folder to `/data/subtitles/candidates/<id>/`.
9. **Multiple subtitle files**: when one download item contains several subtitle files, the original candidate represents one of them and a new candidate is added for each of the rest (`provider_ref` with `#<file name>` appended). Which one the original represents: the file whose content-detected language comes earliest among the selected languages; if that can't be decided (or it's an upload, with no "selected languages"), the first by file name.
10. Update the candidate: `fetch_state = 'ready'`, language, line count, size, original encoding. This update is conditional, and the conditions are in the same statement (the row still exists, is still `fetching`, and the download's `want` is not `remove`); if it updates nothing, delete the folder just moved. Clean up the working directory. `NOTIFY` (`candidates`).

If any step fails: the candidate becomes `fetch_state = 'failed'`, with `fetch_error` being the code in parentheses above; clean up the working directory; `NOTIFY`. This job doesn't retry automatically. A failed candidate can't be "Add"ed: the user can remove it, search again (failed ones from the same source are replaced by the new results), or upload again.

### Adding

`POST /api/candidates/:id/add`, done in `api`:

1. Candidate not fetched yet (`new`): change it to `fetching` and hand it to `api`'s download (`subtitle.resolve`). Still fetching (`fetching`): wait. **Wait at most 30 seconds**; if it doesn't finish, return `CANDIDATE_UNAVAILABLE` (`reason: 'TIMEOUT'`); the background job carries on as usual, and the user just presses it again a bit later. Fetch failed (`failed`): return `CANDIDATE_UNAVAILABLE` with `reason` being `fetch_error`.
2. Read the candidate's list of lines. **Traditional/Simplified conversion happens here**, not at fetch time: whether to convert is the preference of the person adding. If the content is Simplified and should be converted, use `opencc-js` `cn` → `twp` (characters and wording both changed to Taiwan usage) to produce a new list.
3. Compute the sha256 of the final list. If the same film already has an identical one, return `SUBTITLE_DUPLICATE`. **Compute before writing files**, so an ordinary duplicate has created nothing on disk yet.
4. Create `/data/subtitles/<new id>/`: `original.<ext>` (copied from the candidate, untouched) and `cues.json` (the final list). If converted, save the pre-conversion list separately as `cues.original.json`, and `converted_s2t = true`.
5. Pick checkpoints, create the sync doc (if the candidate was aligned, use the segments from that run), and write to `subtitles`. The format column records the original file's format; `.ssa` is recorded as `ass`.
6. If the write in step 5 fails (the film was just deleted; or two people added the same candidate at once and the later one hit the unique constraint), delete the folder created in step 4, then return the matching error (`NOT_FOUND` or `SUBTITLE_DUPLICATE`).

### Why the encoding step can't be skipped

Hand a Big5 file straight to ffmpeg: when decoding subtitles it reports `Invalid UTF-8 in decoded subtitles text`; with stream copy (which is how we pack), **no error is reported, but what gets packed in is garbled**. So every subtitle entering the system is first turned into UTF-8, and the SRT used for packing is always generated by us from the list of lines.

## Matching the downloaded version

A candidate's `matchesRelease` is a hint for the user and also a sort key before ranking:

- The release name contains `YIFY` or `YTS` (case-insensitive), **and**
- The resolution in the name (`720p`, `1080p`, `2160p`) is the same as the downloaded version's, or the name has no resolution

Also compare the source medium: `BluRay`, `BRRip`, `BDRip`, `BrRip` in the name count as Blu-ray; `WEB`, `WEBRip`, `WEB-DL` count as web. Ones of the same kind as the downloaded version sort first.

Sort order before alignment: order of the selected languages → version match → same source medium → the source's rating (if any) → JustSubtitles, YIFY, Assrt.

## Auto-align and rank them all

`POST /api/torrents/:id/candidates/rank`:

1. Take the candidates in the selected languages, at most 30 in the order above. When Traditional Chinese is selected, all of the film's Chinese candidates (`zh-Hant`, `zh-Hans`, `zh`) count: sources' Traditional/Simplified labels are unreliable, and Simplified can be converted to Traditional when adding.
2. Create a `tasks` row (kind `rank`, with `input` recording the candidate IDs to rank this time). If the film already has a ranking running, don't create a new one; just return the current state.
3. Set each candidate's `align_state` to `queued`. Those not fetched yet change to `fetching` and are handed to `api`'s download (then processed by `media`). Then `NOTIFY paiban_media`: candidates whose files are fetched and whose `align_state` is `queued` get `subtitle.rank` done by `media`. `api` doesn't do this step itself.
4. A `subtitle.rank` job runs one full auto-align on one candidate ([08-media-pipeline.md](08-media-pipeline.md)), writes the score back to `align_score` and the result to `align_result`, `align_state = 'done'` (or `failed`). Candidates whose fetch failed also get `align_state` recorded as `failed`.
5. `NOTIFY` (`candidates`) after each one completes, so scores appear in the list one by one; at the same time update that `tasks` row's progress (completed / total).
6. When every candidate in this ranking that still exists has a result (`done` or `failed`), the `tasks` row is `done`. Individual candidates failing doesn't make the whole ranking fail; candidates removed along the way or replaced by new search results don't count. The final tally is done by `media` ("Reconciliation" in [08-media-pipeline.md](08-media-pipeline.md)).

`CandidateList.ranking` is computed from the film's most recent ranking task: `idle` if there has never been one, `running` while queued or in progress, `done` when finished.

The "Recommended" mark (`Candidate.recommended`) is computed on read, same as the prototype: group by language (`zh` merged into `zh-Hant`; `zh-Hans` and `en` each a group), and in each group the one with the highest `align_score`. For candidates whose files have been fetched, the language is already the content-detected result, so the grouping is reliable. If nothing in a group has a score, nothing is marked.

Aligning one usually takes 1 to 3 seconds; Assrt's candidates are slower because of the quota limit. Speech data is needed, so this button can't be pressed until analysis is complete. Ranking jobs use the background queue `subtitle.rank` and don't block the "Auto-align" the user presses in the workbench.

If a candidate has already been aligned, when it is "Add"ed its sync doc starts from that result, so what the user sees on entering the workbench is already-aligned subtitles.

## Source status

Each source's most recent lookup or test result is stored in the `source_health` table (one row per source, overwritten each time); the API shape is `SourceHealth` (`packages/shared/src/contracts/api.ts`): state (`ok`, `warn`, `down`), time, code, data. As elsewhere, it stores codes and numbers; the front end writes the sentences. The administrator's Overview page and Sources page read it. Zimuku is always `manual`; disabled sources are `off`.

| What happened | State |
| --- | --- |
| Lookup or test succeeded | `ok` |
| Over quota, no key set | `warn` |
| Can't connect, response can't be understood, key rejected | `down` |

## Verified and unverified

| Item | Status |
| --- | --- |
| JustSubtitles interface URL, parameters, response fields, 30-result limit, download URL | Checked with a browser on 2026-10-04; **actually called from the server side in Phase 0 on 2026-10-05 (`User-Agent: Paiban/…`, not posing as a browser)**: same fields, 30 results for `EN`, non-browser requests not blocked. A nonexistent ID returns 200 (not 500). Downloaded one archive to see the format: zip, one UTF-8 `.srt`; deleted after looking |
| JustSubtitles title search | Actually called in Phase 0: the outer shape is `{results: [...]}`, see above |
| Official SubDL API | Per its documentation; no key, never actually called |
| YIFY Subtitles page structure and download link | Checked with a browser on 2026-10-04; **pages and downloads actually fetched from the server side in Phase 0 on 2026-10-05**: table column order, the `data-link` (base64) of `a#btn-download-subtitle`, and the decoded host `subtitles.yts-subs.com` all match the document; no CAPTCHA or challenge page. Archive: zip, one UTF-8 (with BOM) `.srt`; deleted after looking |
| Assrt API endpoints, limits, error codes, credit requirement | Per the official documentation; no token, never actually called. The `langlist` key names are from memory |
| TMDB find endpoint | Per the official documentation; no key, never actually called |
| Whether the hosting machine can reach these sites | JustSubtitles and YIFY Subtitles can (Phase 0, on the development machine; whether the deployment machine is the same one is still to be confirmed). TMDB, Assrt and SubDL: no keys, not confirmed yet |
