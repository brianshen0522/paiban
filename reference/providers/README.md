# Provider response samples

These files show the **shape** of what each external source returns, so that parsers and their
unit tests can be written before the network is involved.

They are hand-written from what was verified on 2026-10-04 (field names, nesting, which fields
are strings or numbers). **The values are illustrative, not captured responses.** Item 4 of
phase 0 (docs/14-plan.md) is to record one real response per source and replace these files with
them. Before a real response is written to any file, replace every key, token and signed query
string in it: a value becomes `PLACEHOLDER`, the parameter itself stays, because the tests have
to prove that the parser drops it.

| File | Source | Used by |
| --- | --- | --- |
| `yts.list_movies.sample.json` | YTS `list_movies.json` (a `movie_details.json` answer holds the same movie object under `data.movie`) | docs/05-yts.md |
| `tmdb.find.sample.json` | TMDB `GET /3/find/{imdb id}?external_source=imdb_id&language=zh-TW` | docs/07-subtitle-providers.md |
| `justsubtitles.subtitles.sample.json` | JustSubtitles `GET /api/subtitles/{tmdb id}?lang=…` | same |
| `justsubtitles.search.sample.json` | JustSubtitles title search | same |
| `yify.movie-page.sample.html` | YIFY Subtitles movie page and detail page, reduced to the parts that matter | same |
| `assrt.search.sample.json`, `assrt.detail.sample.json` | 射手網(偽) API | same |

`justsubtitles.subtitles.sample.json` deliberately contains one `url` with a query string
(`?api_key=PLACEHOLDER`). Real responses sometimes carry somebody else's key there. The parser
must drop the query string before the URL is stored, logged or used: write that test first.
