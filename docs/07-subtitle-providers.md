# 07 字幕來源

四個來源加上使用者上傳，**全部在同一個階段完成**（D5）。階段內先做 JustSubtitles，因為它最重要，也因為它把整條路（搜尋 → 下載 → 解壓縮 → 轉碼 → 判斷語言）都走過一遍，其他來源只是換一個取得清單的方法。

| 來源 | 方式 | 查詢依據 | 需要的設定 |
| --- | --- | --- | --- |
| JustSubtitles | 它網站用的 JSON 介面；備援是 SubDL 官方 API | TMDB 編號 | 建議有 TMDB 金鑰；備援模式要 SubDL 金鑰 |
| YIFY Subtitles | 解析網頁 | IMDb 編號 | 無 |
| 射手網（偽） | 官方 API | 片名關鍵字 | API token |
| 字幕庫 | 協助式：只給連結，使用者自己下載後上傳 | 片名 | 無 |
| 上傳 | 使用者拖檔案進來 | | 無 |

這份文件裡各來源的細節是 2026-10-04 查證的。**第三方網站隨時會改。** 階段 0 的第 4 項是對每個來源錄下一份真實回應，和這裡寫的對一次，有出入就更新這份文件和 `reference/providers/` 的範例。

## 共通規則

這些規則適用於每一個來源，實作成共用的 HTTP 用戶端，不要每個來源各寫一套。

- **只連允許的主機。** 每個來源有一份主機清單（下面各節列出）。來源回應裡給的下載網址，主機不在清單裡就不連。解析出來的 IP 是私有位址、loopback、link-local 也不連。轉址最多 3 次，每一次都重新檢查。（開發和測試時用 `ALLOW_LOCAL_SOURCES` 和 `SOURCE_OVERRIDES` 把這些主機換成假的來源，見 [15-testing.md](15-testing.md)；主機清單本身仍然照樣檢查。）
- **逾時 10 秒**（下載檔案 30 秒）。**回應大小上限**：JSON 和 HTML 2 MB，字幕檔 20 MB。
- **`User-Agent: Paiban/<版本>`**，不偽裝成瀏覽器。
- **不繞過任何擋自動存取的機制**（D27）。拿到驗證碼頁、挑戰頁、或明顯不是預期內容的回應，就把這個來源標成 `BAD_RESPONSE` 並停止。不重試、不換標頭、不模擬瀏覽器。
- **金鑰衛生**（D28）：
  - 我們自己的金鑰和 token 盡量放在標頭，不放在網址。不得已要放網址時（SubDL、TMDB v3），記 log 前把 query string 整個去掉。
  - 回應裡出現的任何別人的金鑰（例如 JustSubtitles 的 `url` 有時帶 `?api_key=…`）在**解析的那一刻**就丟掉：取 `url` 時只保留路徑。不存、不記、不使用。這要有單元測試。
- **一個來源失敗不影響其他來源。** 每個來源的結果和錯誤各自寫進 `subtitle_searches`，各自發事件。
- **快取**在 `provider_cache`，有效時間是設定 `providers.cacheHours`（預設 24 小時，1 到 168）。存的是**解析之後**的結果（`FoundSubtitle` 的清單），不是來源的原始回應；原始回應可能夾帶別人的金鑰，解析後的不會。使用者按「重新搜尋」或「重試」時略過快取（`refresh: true`）。
- **各來源的請求排隊**（D41）：對同一個來源，不論是哪個程式發的請求（`api` 的查詢、`media` 的下載），兩個請求之間至少隔一段時間：JustSubtitles（含 SubDL）和 YIFY Subtitles 是 1 秒，射手網是 3.4 秒（每分鐘 18 次以內）。因為請求來自兩個程式，這個隊排在資料庫裡：發請求前呼叫 `select provider_take_slot('<來源>', <毫秒>)`，它回傳「你可以送出的時間」，等到那個時間再送（`db/schema.sql`，有測試）。TMDB 和 YTS 不排這個隊。

### 介面

```ts
interface SubtitleProvider {
  id: 'justsubtitles' | 'yify' | 'assrt';
  hosts: string[];                                    // 允許連的主機(可用尾碼比對)
  search(film: FilmContext, languages: Lang[]): Promise<FoundSubtitle[]>;
  /** 回傳現在可以下載的網址。有些來源的下載網址是臨時的,所以要在下載前才解析。 */
  resolveDownload(ref: string): Promise<{ url: string; fileName?: string }[]>;
  /** 回代碼和資料,不回句子。SourceCheck 定義在 packages/shared/src/contracts/api.ts。 */
  test(): Promise<SourceCheck>;
}

type FilmContext = {
  imdbCode: string; tmdbId: number | null;
  title: string; titleZh: string | null; year: number;
  release: { quality: string; source: string; videoCodec: string };   // 下載的那個版本
};

type FoundSubtitle = {
  ref: string;                 // 這個來源裡的穩定編號
  languageLabel: string;       // 來源自己的說法,原樣保留
  language: DetectedLang;      // 我們的猜測
  releaseName: string; uploader: string | null; pageUrl: string | null;
  hearingImpaired: boolean; rating: number | null;
};
```

### 誰做哪一步

對外的查詢需要金鑰，只有 `api` 解得開，所以分工是：

| 步驟 | 佇列 | 誰 | 做什麼 |
| --- | --- | --- | --- |
| 查詢 | `subtitle.search` | api | 一個來源、一部片一個工作。呼叫 `search`，把結果寫進 `subtitle_candidates` 和 `subtitle_searches`，`NOTIFY`（`candidates`） |
| 問下載網址 | `subtitle.resolve` | api | 一條候選一個工作。呼叫 `resolveDownload`，把網址放進下一個工作的內容裡，排入 `subtitle.fetch`。網址不存進我們自己的資料表，也不寫進 log（工作的內容在佇列的表裡，工作結束後由佇列清掉）。問不到就把候選標成失敗（`DOWNLOAD_FAILED`），並 `NOTIFY paiban_media` 讓排名的進度跟著更新 |
| 下載與處理 | `subtitle.fetch` | media | 下載、解壓縮、轉成句子清單（見「下載與處理」）。做完 `NOTIFY paiban_media`；在等排名的候選（`align_state = 'queued'`）由對帳排入 `subtitle.rank` |
| 上傳的檔案 | `subtitle.ingest` | media | 和上一步相同，只是檔案已經在 `/data/tmp/uploads` |

查詢做成工作而不是在請求裡直接呼叫，有兩個好處：端點可以立刻回應；`api` 重啟時工作會被重新派送，不會留下永遠停在「查詢中」的來源。

這四種短工作不走「等待中 → 進行中」的認領（[08-media-pipeline.md](08-media-pipeline.md) 的「先認領」是給有 `tasks` 的工作用的）：它們的狀態只有「正在做」一種。其餘的規矩照樣要守，尤其是 [03-data-model.md](03-data-model.md)「刪除一個下載時發生的事」的那四條：不替正在被刪除的片開工、寫檔之前再確認一次、最後那一筆更新的條件包含那個下載的 `want` 不是 `remove`。防止重複靠兩件事：排入時用那一列的 id 當佇列的去重鍵；工作一開始先確認那一列還需要它（來源還是 `running`、候選還是 `fetching`），不需要就直接結束。真的被派送了兩次也沒有害處：結果在工作目錄裡準備，最後那一筆帶條件的更新只有一個會成功，另一個把自己準備的東西丟掉。

查詢的工作不自動重試：失敗就把那個來源記成 `error`，由使用者按「重試」。唯一的例外是射手網的額度限制（見它那一節）：那個查詢的工作把自己延後到可以重試的時間再做一次，只此一次。

`api` 處理的這兩種工作做完時直接發 `candidates` 事件；`media` 處理的那兩種用 `NOTIFY`。

## 語言

使用者在字幕分頁選要找的語言（繁體中文、簡體中文、English），預設來自個人設定。

**來源標的語言只能當參考。** 實際查到的情況是繁體字幕常被歸在簡體底下、反之亦然。所以：

- 搜尋時把範圍放寬：要找繁體中文就同時查這個來源所有的中文分類。
- 候選清單同時顯示我們的猜測和來源的原始標籤（原型就是這樣：「繁體中文 `ZH_BG`」）。
- 檔案抓下來之後，**依內容重新判斷**（見「下載與處理」），清單上的語言跟著更新。
- 加入時，如果內容是簡體而使用者的偏好是「簡體字幕自動轉成繁體」，就轉。

| 我們的 | 意思 |
| --- | --- |
| `zh-Hant` | 繁體中文 |
| `zh-Hans` | 簡體中文 |
| `zh` | 是中文，但還不確定繁簡（還沒抓檔，或內容太短） |
| `en` | 英文 |
| `und` | 判斷不出來 |

## JustSubtitles

### 它是什麼

JustSubtitles 的網站前端向自己的 JSON 介面要資料，那個介面不需要登入。字幕資料來自 SubDL，下載檔案也是從 SubDL 的下載主機。網站介面上看不到中文，但介面查得到。

這個介面沒有公開文件，隨時可能改。所以有兩種模式（設定 `providers.justsubtitles.mode`）：

| 模式 | 做法 | 什麼時候用 |
| --- | --- | --- |
| `direct`（預設） | 用 JustSubtitles 的介面 | 正常情況 |
| `subdl` | 用 SubDL 官方 API，同一批字幕 | `direct` 壞掉時，由管理員切換。需要管理員自己申請的 SubDL 金鑰 |

兩種模式回傳的每一筆字幕欄位相同，所以共用同一個解析函式。

允許的主機：`www.justsubtitles.com`、`api.justsubtitles.com`、`search.justsubtitles.com`、`api.subdl.com`、`dl.subdl.com`。

### 查詢（`direct`）

```
GET https://www.justsubtitles.com/api/subtitles/<TMDB 編號>?lang=<語言代碼>
```

（`https://api.justsubtitles.com/api/subtitles/<id>?lang=…` 回一樣的東西，當備用。）

| 事實 | 影響 |
| --- | --- |
| 編號**只認 TMDB 編號**。給 IMDb 編號會回 0 筆 | 要先把 IMDb 編號換成 TMDB 編號，見下一小節 |
| `lang` 一次一種：`EN`、`ZH`、`ZH_BG` | 每種語言一個請求 |
| 每種語言最多回 30 筆，`page` 參數沒有作用 | 拿不到第 31 筆以後的。熱門片的英文字幕會被截斷 |
| 編號不存在時，內容是 `{"status":false,"subtitles":[]}`。2026-10-04 用瀏覽器看到的是 **HTTP 500**，2026-10-05 階段 0 從伺服器端查到的是 **HTTP 200** | 兩種都當成「沒有結果」，不是錯誤。判斷方式看內容不看狀態碼：回應是 JSON 而且 `status` 是 false（狀態碼是 200 或 500 都一樣） |
| 回應帶 `cache-control: public, max-age=86400` | 我們也快取 24 小時 |
| 不是瀏覽器發的請求也會回應；robots.txt 沒有限制 | |

語言對照：

| 要找 | 查哪些 `lang` | 來源的標籤 |
| --- | --- | --- |
| English | `EN` | `english` |
| 繁體中文 | `ZH_BG` 和 `ZH` 都查 | `big_5_code`；`chinese-bg-code` |
| 簡體中文 | `ZH` | `chinese-bg-code` |

`ZH_BG` 是 SubDL 的「Big 5 code」，名義上是繁體；`ZH` 是「Chinese BG code」，名義上是簡體。以 *Inception* 為例查到 `EN` 30 筆、`ZH` 7 筆、`ZH_BG` 3 筆，而且 `ZH` 裡有檔名帶 `.cht` 的繁體字幕。階段 0 從 `ZH` 下載的第一個檔案就是繁體（`.hk.srt`，UTF-8）。

**別人的金鑰確實會出現**：階段 0 錄到的回應裡，`ZH` 和 `ZH_BG` 的**每一筆** `url` 都帶 `?api_key=…`，`EN` 的都沒有。去掉 query string 之後，從 `dl.subdl.com` 下載照樣成功（200、`application/zip`），所以不需要、也不使用那個金鑰。

回應（範例在 `reference/providers/justsubtitles.subtitles.sample.json`）：

```json
{ "status": true,
  "subtitles": [ { "release_name": "…", "name": "…", "lang": "english", "language": "EN",
                   "author": "…", "url": "/subtitle/3467330-8390389.zip", "subtitlePage": "…",
                   "hi": false, "season": 0, "episode": null, "framerate": null, "fps": null,
                   "episode_from": null, "episode_end": 0, "full_season": false } ] }
```

| 欄位 | 用法 |
| --- | --- |
| `url` | **只取路徑**（`/subtitle/<數字>-<數字>.zip`），query string 丟掉。路徑不符合這個樣式就略過這一筆。這個路徑同時是 `ref` |
| `release_name` | 版本名稱，顯示用，也用來判斷是否和下載的版本相符 |
| `language` | 語言代碼，用它對照，不要用 `lang`（文字，格式不一致） |
| `author` | 上傳者 |
| `hi` | 聽障字幕 |
| `subtitlePage` | 接在 `https://www.justsubtitles.com` 後面當作來源頁的連結 |
| 其他 | 影集用的，忽略 |

### 下載

```
GET https://dl.subdl.com<url 的路徑>
```

回應是 `application/zip`。不需要任何參數或金鑰。

### 把 IMDb 編號換成 TMDB 編號

YTS 給的是 IMDb 編號。依序嘗試：

1. 這部片已經查過（`movies.tmdb_id` 或快取）：直接用。
2. **有 TMDB 金鑰**：
   ```
   GET https://api.themoviedb.org/3/find/<IMDb 編號>?external_source=imdb_id&language=zh-TW
   ```
   取 `movie_results[0].id`，順便把 `title` 存成中文片名（和原文片名相同就不存）。金鑰看起來是 v4 的讀取權杖（很長、有兩個點）就放 `Authorization: Bearer`；否則是 v3 金鑰，放 `api_key` 參數（記 log 時去掉）。結果快取 30 天。
3. **沒有 TMDB 金鑰**（D38）：用 JustSubtitles 自己的片名搜尋
   ```
   GET https://search.justsubtitles.com/api/search?q=<片名>
   ```
   回應是 `{"results": [...]}`，每一筆是 TMDB「搜尋電影」的形狀：`id`、`title`、`original_title`、`release_date`（`YYYY-MM-DD`，可能是 null）、`original_language` 等（範例在 `reference/providers/justsubtitles.search.sample.json`，階段 0 錄的）。結果只有電影，沒有 `media_type` 欄位，所以「是電影」這一條不用另外判斷。只在「片名（或原文片名）不分大小寫完全相同、`release_date` 的年份和 YTS 的年份相同」時採用那一筆的 `id`。有多筆符合或沒有符合就放棄。查 *Inception* 時有兩筆片名完全相同（2010 和 1980），年份這一條是必要的。
4. 都失敗：這個來源回報 `NOT_CONFIGURED`，訊息引導管理員設定 TMDB 金鑰。其他來源不受影響。

### 備援模式（`subdl`）

```
GET https://api.subdl.com/api/v1/subtitles?api_key=<金鑰>&imdb_id=<tt…>&type=movie&languages=EN,ZH,ZH_BG&subs_per_page=30
```

- 直接用 IMDb 編號，不需要 TMDB。
- `subs_per_page` 最大 30。
- 免費額度每天 2,000 次請求。下載次數的限制，它的兩份文件寫的不一樣（每 IP 每天 300 次或 50 次），以實際遇到的為準。
- 回應的 `subtitles` 陣列裡每一筆的欄位和上面相同；下載方式相同。
- 金鑰在網址裡，所以這個來源的請求記 log 時一律不記 query string。

### 測試連線

兩種模式在來源設定頁上是兩個各自的測試（`POST /api/admin/sources/justsubtitles/test` 和 `…/subdl/test`），不管目前用的是哪一種模式都可以測：

| 測試 | 做什麼 | 結果 |
| --- | --- | --- |
| `justsubtitles` | 用 `direct` 的介面查 TMDB 編號 27205 的英文字幕 | `OK` 加 `{count}`；回應不是預期的形狀 `BAD_RESPONSE`；連不上 `UNREACHABLE` |
| `subdl` | 用官方 API 查 `imdb_id=tt1375666` | `OK` 加 `{count}`；沒有金鑰 `NOT_CONFIGURED`；金鑰被拒絕 `INVALID_KEY`；超過額度 `RATE_LIMITED` |

TMDB 的測試（`…/tmdb/test`）：對 `tt1375666` 呼叫 find。有結果是 `OK`；沒有金鑰 `NOT_CONFIGURED`；回 401 是 `INVALID_KEY`。

## YIFY Subtitles

沒有 API，解析伺服器產生的網頁。網址是設定 `providers.yify.baseUrl`（預設 `https://yts-subs.com`）。

允許的主機：設定的主機、`subtitles.yts-subs.com`（以及設定主機的 `subtitles.` 子網域）。

### 查詢

```
GET <base>/movie-imdb/<IMDb 編號>
```

頁面裡有一張表，欄位依序是 Rating、Language、Release、Uploader、Download。每一列有連到 `/subtitles/<slug>` 的連結（一列裡有兩個指向同一個 slug 的連結，去重），`<slug>` 就是 `ref`。*Inception* 的頁面有 402 列（English 147、Chinese 6、Big 5 code 2、Chinese BG code 2，其餘是其他語言）。整頁約 290 KB，在 2 MB 的上限內。

- 用結構找（「有這五個欄位標題的表格」），不要依賴 class 名稱。範例在 `reference/providers/yify.movie-page.sample.html`。
- 只留要找的語言的列，其他丟掉。

| 表上的語言 | 我們的猜測 |
| --- | --- |
| `English` | `en` |
| `Chinese` | `zh`（繁簡不明） |
| `Big 5 code` | `zh-Hant` |
| `Chinese BG code` | `zh-Hans` |

要找繁體中文時，三種中文都列出來。

### 下載

1. `GET <base>/subtitles/<slug>`
2. 找 `a#btn-download-subtitle`，它的 `data-link` 屬性是 base64，解開是 zip 的網址：`https://subtitles.yts-subs.com/subtitles/<slug>.zip`
3. 解出來的網址主機不在允許清單裡就放棄。
4. 下載 zip。

找不到那個按鈕、或 `data-link` 解不出一個網址時，**不要自己猜網址去試**。這一筆標成下載失敗（`DOWNLOAD_FAILED`），並把這個來源的狀況記成 `BAD_RESPONSE`：頁面的結構很可能改了，要人來看。

### 測試連線

抓 `tt1375666` 的頁面。解析到列：`OK`，`data` 是 `{rows: 列數}`。解析到 0 列而頁面不是 404，表示版面改了：`BAD_RESPONSE`。連不上：`UNREACHABLE`。

## 射手網（偽）

官方 API，文件在 `https://assrt.net/api/doc`。需要 token（管理員在射手網註冊後從使用者面板取得）。

允許的主機：`api.assrt.net`（備用 `api.makedie.me`），以及 API 回應裡下載網址的主機；後者限定 `assrt.net` 的子網域，實際出現其他網域時先記 log、不連，再由人決定要不要加進清單。

### 限制

- **每個 token 加 IP 每分鐘 20 次。** 我們排隊的間隔設成 3.4 秒，也就是每分鐘 18 次以內（見「共通規則」）。
- 超過會回錯誤碼 `30900`。收到後把這個來源下一次可以送出的時間往後推 60 秒（把 `provider_slots.next_at` 改成 60 秒後），來源狀態標成 `RATE_LIMITED` 並帶上預計重試的時間（`retryAt`）；時間到了自動重試一次。介面上的說法照原型：字幕分頁的來源標籤寫「超過每分鐘 20 次的上限」，旁邊有「重試」；管理頁的來源狀況寫「超過每分鐘 20 次的上限，已自動延後」。
- token 用 `Authorization: Bearer <token>` 標頭送，不放網址。
- **使用條款要求標示來源。** 凡是顯示射手網結果的地方都要有「字幕服務由 assrt.net 提供」和連到 `https://assrt.net` 的連結。API 在 `ProviderStatus.credit` 給名稱和網址（`{name: 'assrt.net', url: 'https://assrt.net'}`），句子由前端寫。

### 查詢

```
GET https://api.assrt.net/v1/sub/search?q=<關鍵字>&cnt=15&pos=0
```

- `q` 至少 3 個字元。`cnt` 最大 15。
- 還有 `is_file`、`no_muxer`、`filelist` 三個參數，確切意義以官方文件為準，第一版不用。
- 它是關鍵字搜尋，不是用編號，所以會混進別的片。做法：
  1. 查 `<英文片名> <年份>`。
  2. 有中文片名（來自 TMDB）時再查一次中文片名。
  3. 兩次結果用 `id` 去重。
  4. 只留 `videoname` 或 `native_name` 裡出現年份、或出現片名（去掉標點、不分大小寫）的結果。
- 一部片最多用掉 2 次查詢額度。

結果的欄位（範例在 `reference/providers/assrt.search.sample.json`）：

| 欄位 | 用法 |
| --- | --- |
| `id` | `ref` |
| `videoname` | 版本名稱。空的時候用 `native_name` |
| `native_name` | 片名 |
| `lang.desc` | 來源的語言說明，原樣當作 `languageLabel` |
| `lang.langlist` | 一個物件，鍵表示有哪些語言：`langcht` 繁體、`langchs` 簡體、`langeng` 英文、`langdou` 雙語（鍵名憑記憶，以實際回應為準）。有繁體就猜 `zh-Hant`，只有簡體猜 `zh-Hans`，只有英文猜 `en` |
| `subtype` | 格式說明。含 `VobSub` 的是圖形字幕，**略過** |
| `release_site`、`vote_score`、`upload_time` | 顯示與排序 |

### 下載

```
GET https://api.assrt.net/v1/sub/detail?id=<id>
```

回應多了 `filename`、`url`（整包的下載網址）和 `filelist`（壓縮檔裡每個檔案各自的下載網址，`f` 是檔名、`s` 是大小、`url` 是網址）。

- **優先用 `filelist`**：挑副檔名是字幕的那些，一個檔案一個網址，不必解壓縮。射手網的檔案很多是 RAR，這樣可以避開。
- `filelist` 是空的才下載 `url` 再解壓縮。
- 這些網址是臨時的，所以 `resolveDownload` 在真正要下載前才呼叫，網址只放在工作的內容裡，不存進 `subtitle_candidates.download_url`。
- 每抓一筆要用一次查詢額度。「全部自動對齊並排名」會抓很多筆，所以射手網的候選會一筆一筆慢慢出現，這是正常的。

### 錯誤碼

| 代碼 | 意思 | 我們的處理 |
| --- | --- | --- |
| `1` | 使用者不存在 | `NOT_CONFIGURED` |
| `101` | 關鍵字少於 3 個字元 | 不該發生；略過那次查詢 |
| `20000` | 缺少參數 | `BAD_RESPONSE` |
| `20001` | token 無效 | `NOT_CONFIGURED` |
| `20400` | 端點不存在 | `BAD_RESPONSE` |
| `20900` | 找不到字幕 | 那一筆標成下載失敗 |
| `30000`、`30001`、`30002`、`30300` | 伺服器、資料庫、搜尋或 API 暫時無法使用 | `UNREACHABLE` |
| `30900` | 超過額度 | `RATE_LIMITED`，見上 |

### 測試連線

呼叫 `GET /v1/user/quota`。成功是 `OK`，`data` 是 `{quota: 剩餘額度}`；沒有 token 是 `NOT_CONFIGURED`；token 無效（`20001`）是 `INVALID_KEY`。

## 字幕庫（協助式）

字幕庫用驗證碼擋自動存取，所以**系統完全不連它**（D27）。

- 設定 `providers.zimuku.enabled` 決定字幕分頁要不要顯示這張卡片。
- 設定 `providers.zimuku.searchUrl` 是一個含 `{q}` 的網址樣板。它的網域也常換，**沒有預設值**，由管理員填現在能用的。沒填就不顯示按鈕。
- 按鈕在新分頁開啟 `searchUrl`，`{q}` 換成「片名 年份」（有中文片名就用中文片名）。連結帶 `rel="noopener noreferrer"`。
- 卡片上寫兩個步驟：開啟搜尋頁、通過驗證後下載壓縮檔；把壓縮檔拖到上傳區。

## 上傳

- 接受 `.srt`、`.ass`、`.ssa`、`.vtt`、`.zip`、`.rar`、`.7z`，上限 20 MB。（介面上的句子照原型只列 `.srt`、`.ass`、`.vtt`；`.ssa` 也收，只是不特別寫出來。）
- `api` 把檔案存到 `/data/tmp/uploads/<uuid>`，算出它的 sha256，**當場建立一條候選**（`provider = 'upload'`、`provider_ref` 是 sha256、`release_name` 是檔名、`fetch_state = 'fetching'`），排入 `subtitle.ingest`，立刻回傳候選清單。使用者馬上看得到一列「處理中」。
- 後續處理和從來源下載的檔案完全一樣。壓縮檔裡有好幾個字幕檔時，原本那條候選變成其中一個，其餘的各新增一條。
- 處理成功，那一列變成可以「加入」。處理失敗，那一列顯示原因（`fetchError`）和「移除」（`DELETE /api/candidates/:id`）。這樣讀不了的檔案不會無聲無息地消失。
- 同一個檔案再上傳一次：不會多一列。已經處理好的原樣回傳；上次失敗的重新處理一次。

## 下載與處理（`subtitle.fetch` / `subtitle.ingest`）

不論檔案從哪來，都走同一條路。參考實作在 `reference/subtitles/text.mjs`，測試素材在 `fixtures/`。

1. **下載**（上傳的跳過）：先取號排隊，再做主機檢查、大小上限、逾時。抓不到就是 `DOWNLOAD_FAILED`。
2. **判斷是不是壓縮檔**：看檔頭，不看副檔名。
3. **解壓縮**到 `/data/tmp/work/<job>/`，有這些限制，違反任何一條就整包拒絕（`ARCHIVE_INVALID`）：
   - 最多 200 個項目；解開後總共不超過 50 MB；單一檔案不超過 10 MB
   - 項目路徑不能是絕對路徑、不能含 `..`、不能是符號連結
   - 打不開、格式壞掉也是 `ARCHIVE_INVALID`
   - 只取 `.srt`、`.ass`、`.ssa`、`.vtt`；其他（`.sub`/`.idx`、`.txt`、`.nfo`、`__MACOSX/`）忽略
   - 打得開但一個字幕檔都沒有：`NO_SUBTITLE`
   - zip 用 Node 的函式庫；7z 和 rar 用映像檔裡的工具。**rar 的解壓工具還沒驗證**，見 [16-risks.md](16-risks.md)
4. **轉成文字**：依序看 BOM → 嚴格的 UTF-8 → 試 Big5、GB18030、Shift_JIS、EUC-KR、Windows-1252，取解出來最像語言的那個。記下原本的編碼。
5. **解析成句子**：SRT、VTT 用解析函式庫；ASS 只取 `Dialogue`，去掉繪圖指令和樣式標記，`\N` 變成換行（D34）。
6. **正規化**：
   - 換行統一成 `\n`，去掉每句頭尾空白，丟掉沒有文字的句子
   - 負的時間夾到 0；結束時間不晚於開始時間的，結束時間設成開始後 1 秒
   - 依開始時間排序，重新編號 1 到 n（這個編號就是 `Cue.id`，同步文件的逐句修改用它當鍵）
   - 文字內容不動（SRT 裡的 `<i>` 之類的標記保留，匯出時原樣寫回；畫面上顯示時再處理）
   - 一句都沒有就當成失敗（`PARSE_FAILED`）
7. **判斷語言**（依內容）：中文字夠多就是中文，再用繁簡轉換比對哪一種字比較多；否則看是不是英文。
8. **寫檔**：在工作目錄裡準備好 `original.<ext>`（原始位元組）和 `cues.json`（句子清單），確認那部片沒有在被刪除，再把整個資料夾搬到 `/data/subtitles/candidates/<id>/`。
9. **多個字幕檔**：一個下載項目裡有好幾個字幕檔時，原本那條候選代表其中一個，其餘的各新增一條候選（`provider_ref` 加上 `#<檔名>`）。原本那條代表哪一個：依內容判斷出來的語言在所選語言裡排最前面的那個檔案；分不出來（或是上傳的檔案，沒有「所選語言」）就取依檔名排序的第一個。
10. 更新候選：`fetch_state = 'ready'`、語言、句數、大小、原始編碼。這一筆更新帶條件，而且條件寫在同一個敘述裡（那一列還在、還是 `fetching`、那個下載的 `want` 不是 `remove`）；改不到就把剛搬過去的資料夾刪掉。清掉工作目錄。`NOTIFY`（`candidates`）。

任何一步失敗：候選變成 `fetch_state = 'failed'`，`fetch_error` 是上面括號裡的代碼；清掉工作目錄；`NOTIFY`。這個工作不自動重試。失敗的候選不能「加入」：使用者可以把它移除，或重新搜尋（同一個來源裡失敗的會被新的結果取代）、重新上傳。

### 加入

`POST /api/candidates/:id/add`，在 `api` 裡做：

1. 候選還沒抓（`new`）：排入 `subtitle.resolve`。還在抓（`fetching`）：等。**最多等 30 秒**；等不到回 `CANDIDATE_UNAVAILABLE`（`reason: 'TIMEOUT'`），背景的工作照常繼續，使用者晚一點再按一次就好。抓失敗（`failed`）：回 `CANDIDATE_UNAVAILABLE`，`reason` 是 `fetch_error`。
2. 讀出候選的句子清單。**繁簡轉換在這裡做**，不在抓檔時做：要不要轉是加入的人的偏好。內容是簡體而且要轉的話，用 `opencc-js` 的 `cn` → `twp`（字和用語都換成台灣的說法）轉出新的清單。
3. 算最後那份清單的 sha256。同一部片已經有相同的就回 `SUBTITLE_DUPLICATE`。**先算再寫檔**，這樣一般的重複在磁碟上什麼都還沒建立。
4. 建立 `/data/subtitles/<新 id>/`：`original.<ext>`（從候選複製，原封不動）、`cues.json`（最後的清單）。有轉換的話，轉換前的清單另存成 `cues.original.json`，`converted_s2t = true`。
5. 挑檢查點，建立同步文件（候選對齊過就用那次的分段），寫入 `subtitles`。格式欄記的是原始檔的格式，`.ssa` 記成 `ass`。
6. 第 5 步的寫入失敗時（那部片剛好被刪了；或兩個人同時加入同一條，後到的撞到唯一限制），把第 4 步建立的資料夾刪掉，再回對應的錯誤（`NOT_FOUND` 或 `SUBTITLE_DUPLICATE`）。

### 編碼這一步為什麼不能省

把 Big5 的檔案直接交給 ffmpeg：解碼字幕時會報 `Invalid UTF-8 in decoded subtitles text`；如果用串流複製（我們封裝時就是），**不會報錯，但封進去的是亂碼**。所以進到系統裡的字幕一律先變成 UTF-8，封裝用的 SRT 也一律由我們自己從句子清單產生。

## 和下載的版本相符

候選的 `matchesRelease` 是給使用者的提示，也是排名前的排序依據：

- 版本名稱含 `YIFY` 或 `YTS`（不分大小寫），**而且**
- 名稱裡的解析度（`720p`、`1080p`、`2160p`）和下載的版本相同，或名稱裡沒有寫解析度

另外比對片源：名稱裡的 `BluRay`、`BRRip`、`BDRip`、`BrRip` 算藍光；`WEB`、`WEBRip`、`WEB-DL` 算網路。和下載的版本同一種的排前面。

還沒對齊前的排序：所選語言的順序 → 版本相符 → 片源相同 → 來源的評分（有的話）→ JustSubtitles、YIFY、射手網。

## 全部自動對齊並排名

`POST /api/torrents/:id/candidates/rank`:

1. 取所選語言的候選，依上面的順序最多取 30 條。選了繁體中文時，這部片所有中文的候選（`zh-Hant`、`zh-Hans`、`zh`）都算在內：來源標的繁簡不可靠，而且簡體可以在加入時轉成繁體。
2. 建立一列 `tasks`（種類 `rank`，`input` 記下這次要排的候選 id）。這部片已經有一次排名在跑的話，不建立新的，直接回現況。
3. 每一條候選的 `align_state` 設成 `queued`。還沒抓的排入 `subtitle.resolve`（之後接 `subtitle.fetch`）。然後 `NOTIFY paiban_media`：檔案抓好而且 `align_state` 是 `queued` 的候選，由 `media` 的對帳排入 `subtitle.rank`。`api` 不直接排這個佇列。
4. `subtitle.rank` 的工作對一條候選做一次完整的自動對齊（[08-media-pipeline.md](08-media-pipeline.md)），把分數寫回 `align_score`、結果寫回 `align_result`，`align_state = 'done'`（或 `failed`）。抓檔失敗的候選，`align_state` 也記成 `failed`。
5. 每完成一條就 `NOTIFY`（`candidates`），清單上的分數一條一條出現；同時更新那一列 `tasks` 的進度（完成數 / 總數）。
6. 這次要排的候選裡，還存在的都有了結果（`done` 或 `failed`），`tasks` 那一列就是 `done`。個別候選失敗不算整次排名失敗；途中被移除或被新的搜尋結果取代的候選不算在內。結算由 `media` 做（[08-media-pipeline.md](08-media-pipeline.md) 的「對帳」）。

`CandidateList.ranking` 是從這部片最近一次的排名工作算出來的：沒有過是 `idle`，還在排隊或進行中是 `running`，結束了是 `done`。

「建議」的標記（`Candidate.recommended`）是讀取時算的，和原型相同：依語言分組（`zh` 併進 `zh-Hant`；`zh-Hans`、`en` 各一組），每一組裡 `align_score` 最高的那一條。抓過檔的候選，語言已經是依內容判斷的結果，所以分組是可靠的。整組都沒有分數就不標。

對齊一條通常 1 到 3 秒；射手網的候選受額度限制會比較慢。需要人聲資料，所以分析還沒完成時這個按鈕不能按。排名的工作用背景的佇列 `subtitle.rank`，不會擋住使用者在工作台按的「自動對齊」。

候選已經對齊過的話，「加入」時它的同步文件就從那次的結果開始，使用者進工作台看到的已經是對過的字幕。

## 來源狀況

每個來源最近一次查詢或測試的結果存在 `source_health` 資料表（每個來源一列，每次覆寫），API 的形狀是 `SourceHealth`（`packages/shared/src/contracts/api.ts`）：狀態（`ok`、`warn`、`down`）、時間、代碼、資料。和其他地方一樣，存的是代碼和數字，句子由前端寫。管理員的總覽頁和來源設定頁讀它。字幕庫固定是 `manual`；停用的來源是 `off`。

| 發生什麼 | 狀態 |
| --- | --- |
| 查詢或測試成功 | `ok` |
| 超過額度、沒有設定金鑰 | `warn` |
| 連不上、回應看不懂、金鑰被拒絕 | `down` |

## 已查證與未查證

| 項目 | 狀況 |
| --- | --- |
| JustSubtitles 介面的網址、參數、回應欄位、30 筆上限、下載網址 | 2026-10-04 用瀏覽器查過；**2026-10-05 階段 0 從伺服器端（`User-Agent: Paiban/…`，沒有偽裝成瀏覽器）實際呼叫**：欄位相同、`EN` 30 筆、沒有擋非瀏覽器的請求。不存在的編號回 200（不是 500）。下載了一個壓縮檔看格式：zip、一個 UTF-8 的 `.srt`，看完已刪 |
| JustSubtitles 片名搜尋 | 階段 0 實際呼叫：外層是 `{results: [...]}`，見上 |
| SubDL 官方 API | 依它的文件；沒有金鑰，沒有實際呼叫過 |
| YIFY Subtitles 的頁面結構和下載連結 | 2026-10-04 用瀏覽器查過；**2026-10-05 階段 0 從伺服器端實際抓頁面和下載**：表格欄位順序、`a#btn-download-subtitle` 的 `data-link`（base64）、解出來的主機 `subtitles.yts-subs.com` 都和文件相同，沒有驗證碼或挑戰頁。壓縮檔：zip、一個 UTF-8（有 BOM）的 `.srt`，看完已刪 |
| 射手網 API 的端點、限制、錯誤碼、標示來源的要求 | 依官方文件；沒有 token，沒有實際呼叫過。`langlist` 的鍵名是憑記憶 |
| TMDB 的 find 端點 | 依官方文件；沒有金鑰，沒有實際呼叫過 |
| 從架站的那台機器能不能連到這些網站 | JustSubtitles、YIFY Subtitles 可以（階段 0，在開發機上；部署機器是不是同一台待確認）。TMDB、射手網、SubDL 沒有金鑰，還沒有確認 |
