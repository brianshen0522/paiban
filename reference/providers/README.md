# Provider response samples

These files show what each external source returns, so that parsers and their unit tests can be
written before the network is involved.

Some are **real responses recorded in phase 0** (2026-10-05, by `scripts/phase0/check-sources.mjs`,
for *Inception*: IMDb `tt1375666`, TMDB `27205`); the rest are still **hand-written shapes** because
the source needs an address or key that was not available yet. The table says which is which.

Before a real response is written to any file, every key, token and signed query string in it is
replaced: the value becomes `PLACEHOLDER`, the parameter itself stays, because the tests have to
prove that the parser drops it. The recording script does this before writing to disk.

| File | Source | Kind |
| --- | --- | --- |
| `justsubtitles.subtitles.sample.json` | JustSubtitles `GET /api/subtitles/27205?lang=ZH` | **Recorded.** Every `url` carried somebody else's `api_key` (now `PLACEHOLDER`) |
| `justsubtitles.subtitles.en.sample.json` | JustSubtitles `GET /api/subtitles/27205?lang=EN` | **Recorded.** 30 entries (the cap); no query strings |
| `justsubtitles.subtitles.missing.sample.json` | JustSubtitles `GET /api/subtitles/999999999?lang=EN` | **Recorded.** Answered with HTTP **200** (not 500) and this body |
| `justsubtitles.search.sample.json` | JustSubtitles `GET https://search.justsubtitles.com/api/search?q=Inception` | **Recorded.** `{results: [...]}` in TMDB movie-search shape |
| `yify.movie-page.sample.html` | YIFY Subtitles `GET /movie-imdb/tt1375666` | **Recorded**, whole page. The analytics beacon's `"token"` is `PLACEHOLDER` |
| `yify.subtitle-page.sample.html` | YIFY Subtitles `GET /subtitles/<slug>` (a Chinese entry) | **Recorded**, whole page. `a#btn-download-subtitle[data-link]` is base64 of the zip URL |
| `yts.list_movies.sample.json` | YTS `GET https://yts.gg/api/v2/list_movies.json?query_term=tt1375666&limit=1` | **Recorded** 2026-10-06. YTS answers carry no keys |
| `yts.movie_details.sample.json` | YTS `movie_details.json?movie_id=1606`: the same movie object under `data.movie` | **Recorded** |
| `yts.list_movies.empty.sample.json` | A search with no result | **Recorded**: `data` has no `movies` key at all |
| `tmdb.find.sample.json` | TMDB `GET /3/find/{imdb id}?external_source=imdb_id&language=zh-TW` | Hand-written: no TMDB key yet |
| `assrt.search.sample.json`, `assrt.detail.sample.json` | Assrt (Shooter) API | Hand-written: no token yet. `langlist` key names still unconfirmed |

`justsubtitles.subtitles.sample.json` contains `url`s with a query string (`?api_key=PLACEHOLDER`).
Real responses carry somebody else's key there. The parser must drop the query string before the
URL is stored, logged or used: write that test first.

To record the remaining sources once the address or key exists, fill it in (`deploy/.env` for keys,
`YTS_BASE_URL=https://… ` on the command line for YTS) and run
`node scripts/phase0/check-sources.mjs --only <yts|tmdb|assrt|subdl>`.
