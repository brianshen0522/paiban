# 05 YTS integration

YTS is the only source for film search and version lists. It offers a public JSON API that needs no key.

## The address is set by hand by an administrator

YTS domains are unstable, and there are many impostor sites:

- `yts.mx` disappeared in November 2025; after that came `yts.lt`, and in January 2026 `yts.bz`.
- When checked on 2026-10-04, `yts.bz/api` redirected to `yts.gg/api`.

So:

- The address is the setting `yts.baseUrl`, filled in by an administrator on the "Sources" page. **The program never looks for a new domain by itself**: not from search engines, not from lists, not by inferring from redirects.
- **Do not follow redirects to another host.** On a 3xx whose destination is a different host, treat it as a failure (`YTS_UNREACHABLE`), and explain in the "Test connection" result: "This domain redirects requests to `<host>`. Make sure that is the real one before changing the setting to it." Redirects within the same host (for example adding a trailing slash) may be followed.
- There is no built-in default. On first start this setting is empty: the search and download endpoints return `YTS_NOT_CONFIGURED`, and the Search page shows "The YTS address is not set yet." and guides the administrator to set it.

Validation rules: starts with `https://`, host only (a port is allowed), no path, must not point to an internal address. Strip the trailing slash when saving. In development and testing, `ALLOW_LOCAL_SOURCES=1` relaxes this to allow `http://` and internal addresses, so it can point to the fake YTS ([15-testing.md](15-testing.md)).

Requests to YTS go through the shared outbound HTTP client ("Outbound requests" in [12-auth.md](12-auth.md)). This client must be done in phase 2; the subtitle sources in phase 5 reuse it as is.

## The two endpoints we use

`{base}` is the setting value, for example `https://yts.example`.

### Search and listing

```
GET {base}/api/v2/list_movies.json
```

| Parameter | Value | Maps to our |
| --- | --- | --- |
| `query_term` | Title, IMDb ID, actor, director | `q` |
| `quality` | `720p`, `1080p`, `2160p`, `3D` | `quality` |
| `genre` | English genre name, see the table below | `genre` |
| `minimum_rating` | Integer from 0 to 9 | `minRating` |
| `sort_by` | `date_added`, `rating`, `year`, `seeds` (also `title`, `peers`, `download_count`, `like_count`, which we don't use) | `sort`: `added`, `rating`, `year`, `seeds` |
| `order_by` | `desc` | Fixed |
| `limit` | 1 to 50 | Fixed at 24 |
| `page` | Starts at 1 | `page` |

The outer layer of the response:

```json
{ "status": "ok", "status_message": "Query was successful",
  "data": { "movie_count": 123, "limit": 24, "page_number": 1, "movies": [ … ] } }
```

Note: **when there are no results, `data` has no `movies` key** (not an empty array). When `status` is not `ok`, `status_message` gives the reason.

### Single film

```
GET {base}/api/v2/movie_details.json?movie_id=<id>
```

The response is `data.movie`, with the same fields as each film in the list.

### Film fields

Only the ones we use are listed. A full example of the shape is in `reference/providers/yts.list_movies.sample.json` (the values are illustrative; the field names follow what was verified).

| YTS field | Use |
| --- | --- |
| `id` | Our `ytsId` |
| `imdb_code` | Starts with `tt`. Used to look up TMDB and YIFY Subtitles |
| `title`, `title_english`, `year`, `runtime`, `rating`, `genres`, `summary`, `language` | Display. `runtime` is in minutes and **may be 0** (YTS left it empty); in that case the preview reservation estimates 120 minutes |
| `medium_cover_image` | Poster. Fetched by the server on the browser's behalf |
| `torrents[]` | Version list |

Each version (one item of `torrents[]`):

| YTS field | Type | Description |
| --- | --- | --- |
| `hash` | string | Info hash, 40 hex characters, **uppercase**. Convert to lowercase before storing in the database |
| `quality` | string | `720p`, `1080p`, `2160p`, `3D` |
| `type` | string | `bluray` or `web` |
| `video_codec` | string | `x264` or `x265` |
| `bit_depth` | **string** | `"8"` or `"10"` |
| `audio_channels` | string | `"2.0"` or `"5.1"` |
| `size_bytes` | number | Used when admitting a download |
| `size` | string | For example `"1.6 GB"`. Don't use it; format `size_bytes` yourself |
| `seeds`, `peers` | number | The values from YTS's last count, not live |
| `date_uploaded_unix` | number | Seconds |
| `url` | string | Download URL of the .torrent file. **Not used**; we only use the hash |

Every response is validated with zod. If a required field (`id`, `imdb_code`, `title`, `year`, `torrents[].hash`, `torrents[].size_bytes`) is missing, skip that film or that version and log it; if the whole response is not the expected shape (not JSON, an HTML page, no `status` field), return `YTS_BAD_RESPONSE`. This usually means the domain is no longer YTS.

### Genres

YTS genres are in English. Queries use the English value; the interface shows the Chinese name.

| Value | Display | Value | Display | Value | Display |
| --- | --- | --- | --- | --- | --- |
| `action` | 動作 (Action) | `drama` | 劇情 (Drama) | `mystery` | 懸疑 (Mystery) |
| `adventure` | 冒險 (Adventure) | `family` | 家庭 (Family) | `romance` | 愛情 (Romance) |
| `animation` | 動畫 (Animation) | `fantasy` | 奇幻 (Fantasy) | `sci-fi` | 科幻 (Sci-fi) |
| `biography` | 傳記 (Biography) | `film-noir` | 黑色電影 (Film noir) | `sport` | 運動 (Sport) |
| `comedy` | 喜劇 (Comedy) | `history` | 歷史 (History) | `thriller` | 驚悚 (Thriller) |
| `crime` | 犯罪 (Crime) | `horror` | 恐怖 (Horror) | `war` | 戰爭 (War) |
| `documentary` | 紀錄片 (Documentary) | `music` / `musical` | 音樂 / 歌舞 (Music / Musical) | `western` | 西部 (Western) |

`genres` in the response is capitalized English (`"Sci-Fi"`); before display, convert it with the same table (matching is case-insensitive). Anything not in the table is shown as is. Confirm once in phase 0, against the real YTS, whether the query parameter is case-sensitive.

## How a version becomes our `Version`

```
directPlay   = video_codec == "x264" && bit_depth == "8"
previewBytes = directPlay ? 0 : previewReservation(runtime, current settings)   see 10-storage.md
needBytes    = size_bytes + previewBytes
```

`directPlay` here is only a prediction; after the download finishes, the ffprobe result decides (see [08-media-pipeline.md](08-media-pipeline.md)). `previewBytes` uses the settings at query time (whether automatic conversion is on, resolution); it is computed again when someone actually presses download, and fixed from that moment on (D40).

Each version also carries the local situation (`local`): whether the system has a download for this info hash, its status, progress, who holds it, and whether the caller holds it. If there is none, compute whether it would fit right now.

## Magnet links

The hash alone is enough to download. What we hand to WebTorrent is:

```
magnet:?xt=urn:btih:<lowercase hash>&dn=<title+year+quality, URL-encoded>&tr=<tracker 1>&tr=<tracker 2>…
```

The tracker list is the setting `downloads.trackers`. Take the default from the list in the YTS API documentation at the time (confirm once we have the YTS address). Until then use the two below; they responded in the phase 0 test on 2026-10-05 (`scripts/phase0/real-swarm.mjs`):

```
udp://tracker.opentrackr.org:1337/announce
udp://open.demonii.com:1337/announce
```

The other two originally written from memory no longer work: `udp://tracker.openbittorrent.com:80` fails DNS lookup (`ENOTFOUND`), and `udp://p4p.arenabg.com:1337` times out.

DHT is on, so even when every tracker fails, peers can usually still be found, just more slowly. Tested in phase 0 on a Docker bridge network: DHT and uTP both work, and the torrent info arrives 4 to 8 seconds after adding.

## Caching

Stored in `provider_cache` with `provider = 'yts'`. What is stored is our own shape after validation and parsing (film data and version lists), not YTS's raw response.

| Content | Key | Valid for |
| --- | --- | --- |
| Search results | Parameter combination | 10 minutes |
| Single film | `movie:<id>` | 60 minutes |

Expired rows are not cleaned up; they are only overwritten the next time new data is fetched.

**When YTS can't be reached**: search returns `YTS_UNREACHABLE`; for a single film, if a copy was stored (no matter how old), that copy is used, with `stale` true and `fetchedAt` set to the time of that data in the response, and the film page then shows "This is data saved earlier." This means a film page someone has already seen still opens and can still download while YTS is down: those hashes really did come from YTS, which satisfies D26.

## Posters

The browser never connects to YTS directly (D30).

- `GET /api/yts/movies/:ytsId/poster` has the server fetch `medium_cover_image` and return it, with `Cache-Control: private, max-age=86400`.
- Only image URLs whose host equals the host of `yts.baseUrl`, or is a subdomain of it, are fetched; others are not fetched and return 404.
- The response must be an image (`image/jpeg`, `image/png`, `image/webp`), at most 2 MB.
- When a film is downloaded, save a copy of the poster to `/data/posters/<yts_id>.jpg`. That way a YTS domain change does not affect the Library.
- **Which country's poster** (Brian, 2026-10-10): the poster endpoint takes `region` (`TW`, `HK`, `CN`, `US`, `JP`, `KR`; default `TW`), and the front end passes it from each person's setting (`UserPrefs.posterRegion`; if not chosen, `TW` for the Chinese interface and `US` for the English interface). The server uses TMDB's `/3/movie/<tmdb id>?language=zh-TW|zh-HK|zh-CN|en-US|ja-JP|ko-KR` to get that country's `poster_path` (TMDB posters are tagged with a country; tested on 2026-10-10 with a real key on three films, and each of the five languages got a different poster), cached for one week. Order: the stored copy for that country → TMDB's poster for that country → TMDB's default poster → the YTS cover → the copy saved at download time.
- For films in the Library (a row exists in `movies`), each country's poster is saved to `/data/posters/<yts_id>-<country>.<extension>` the first time it is fetched, and read from there afterward. Films added by hand that YTS doesn't have use `GET /api/movies/:id/poster?region=`, saved as `tmdb-<tmdb id>-<country>.<extension>`. These copies don't count toward usage and are deleted along with the film.
- When nothing can be fetched, the front end draws a placeholder poster: a fixed background color computed from the title, with the title and year on it (this is how the prototype draws it).

## Request etiquette

- 10-second timeout. Retry once on network errors and 5xx; no retries otherwise.
- `User-Agent` is `Paiban/<version>`.
- At most 4 concurrent requests.
- Response size limit of 5 MB.

## Test connection

"Test connection" on the admin page calls `list_movies.json?limit=1`. The result is a `SourceCheck` (`packages/shared/src/contracts/api.ts`):

| Case | `code` | `data` |
| --- | --- | --- |
| Success, the response has the YTS shape | `OK` | `{status: 200, count: total number of films in the catalog}` |
| Address not filled in yet | `NOT_CONFIGURED` | |
| Redirected to another host | `REDIRECTED` | `{host: destination host}` |
| Unreachable, timeout, 5xx | `UNREACHABLE` | `{status}` (if any) |
| The response is not the YTS shape | `BAD_RESPONSE` | |

`ms` is how long it took. The sentence in the interface is written by the front end from the code, for example "This domain redirects requests to yts.example. Make sure that is the real one before changing the setting to it."

## Fake YTS for development and testing

Automated tests and local development **never connect to the real YTS**. Build a fake YTS (the same two endpoints, the same response shapes); the film list can simply be the 14 old public-domain films from the prototype (`MOVIES` in `prototype/platform/src/app1.js`). One version of one of them must map to the torrent used for local testing, so the whole flow can run without a network. How to do it is in [15-testing.md](15-testing.md).

## Film data now comes from TMDB (Brian, 2026-10-06)

YTS is only responsible for "which films exist and which versions can be downloaded". The film data people see now comes from TMDB: with the IMDb ID from YTS, call `GET /3/find/<imdb>?external_source=imdb_id&language=zh-TW` once to get the TMDB ID, Chinese title, Chinese overview, poster path and rating (`apps/server/src/tmdb/tmdb.ts`).

- The result is stored in `provider_cache` (`tmdb`, `film:<imdb>`) for one week; films TMDB doesn't know are stored for one day. When the film is already in the database, also write `movies.tmdb_id` and `title_zh`, so subtitle sources use the TMDB ID directly.
- The Search page shows 24 films per page; for those not in the cache, ask at most 6 at a time and wait at most 2.5 seconds. Those not answered in time use YTS's data this time, and the answers are still stored in the cache for next time.
- Ratings: use TMDB's when TMDB has 5 or more votes, otherwise YTS's IMDb rating. The page states the source.
- Posters: if there is a TMDB poster, this server fetches `image.tmdb.org/t/p/w342/…` (the browser never connects to TMDB directly, D30); only otherwise is the YTS cover used.
- With no TMDB key, or when the key is rejected, everything falls back to YTS's data; a rejected key is shown on the TMDB card in Sources.
- IMDb IDs are still kept: YTS and YIFY Subtitles only recognize them.

### Finding films by Chinese title (Brian, 2026-10-06)

YTS only recognizes English titles; typing "謎中謎" (the Chinese title of *Charade*) finds nothing. So while typing in the search box (after a 0.25-second pause), the server asks TMDB's `GET /3/search/movie?query=…&language=zh-TW&include_adult=false` for suggestions, up to 8 films, listed under the search box: small poster, Chinese title, original title and year. Clicking one (or choosing it with the arrow keys and pressing Enter): the server gets its IMDb ID with `GET /3/movie/<tmdbId>/external_ids`, then uses that ID as YTS's `query_term` (YTS search recognizes IMDb IDs); if found, it opens that film's page directly; if YTS doesn't have it, that row says "YTS doesn't have this film." Pressing Enter without choosing any suggestion searches YTS with the typed text as before. Both the top bar and the Search page's search box have this. With no TMDB key, no suggestions are shown and TMDB is not contacted. Caching: suggestions one day, IMDb IDs one month, "does YTS have it" one hour.
