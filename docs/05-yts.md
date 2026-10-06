# 05 YTS 串接

YTS 是電影搜尋和版本清單的唯一來源。它提供公開的 JSON API，不需要金鑰。

## 網址由管理員手動設定

YTS 的網域不穩定，而且冒牌站很多：

- `yts.mx` 在 2025 年 11 月消失，之後出現 `yts.lt`，2026 年 1 月是 `yts.bz`。
- 2026-10-04 查證時，`yts.bz/api` 會被轉址到 `yts.gg/api`。

所以：

- 網址是設定 `yts.baseUrl`，由管理員在「來源設定」頁填寫。**程式不自己找新網域**，不從搜尋引擎、不從清單、不從轉址推斷。
- **不跟隨跨主機的轉址。** 收到 3xx 而且目的地是另一個主機時，當成失敗（`YTS_UNREACHABLE`），並在「測試連線」的結果裡說明「這個網域把請求轉到 `<主機>`，確認那是真的之後再把設定改過去」。同一個主機內的轉址（例如補上結尾斜線）可以跟。
- 沒有內建預設值。第一次啟動時這個設定是空的：搜尋和下載的端點回 `YTS_NOT_CONFIGURED`，搜尋頁顯示「還沒有設定 YTS 的網址」並引導管理員去設定。

驗證規則：`https://` 開頭、只有主機（可以有埠），不含路徑，不能指向內部位址。儲存時去掉結尾的斜線。開發和測試時用 `ALLOW_LOCAL_SOURCES=1` 放寬成可以填 `http://` 和內部位址，這樣才能指到假的 YTS（[15-testing.md](15-testing.md)）。

對 YTS 的請求走共用的對外 HTTP 用戶端（[12-auth.md](12-auth.md) 的「對外請求」）。這個用戶端在階段 2 就要做好，階段 5 的字幕來源直接沿用。

## 用到的兩個端點

`{base}` 是設定值，例如 `https://yts.example`。

### 搜尋與列表

```
GET {base}/api/v2/list_movies.json
```

| 參數 | 值 | 對應到我們的 |
| --- | --- | --- |
| `query_term` | 片名、IMDb 編號、演員、導演 | `q` |
| `quality` | `720p`、`1080p`、`2160p`、`3D` | `quality` |
| `genre` | 英文類型名，見下表 | `genre` |
| `minimum_rating` | 0 到 9 的整數 | `minRating` |
| `sort_by` | `date_added`、`rating`、`year`、`seeds`（還有 `title`、`peers`、`download_count`、`like_count`，用不到） | `sort`：`added`、`rating`、`year`、`seeds` |
| `order_by` | `desc` | 固定 |
| `limit` | 1 到 50 | 固定 24 |
| `page` | 從 1 開始 | `page` |

回應的外層：

```json
{ "status": "ok", "status_message": "Query was successful",
  "data": { "movie_count": 123, "limit": 24, "page_number": 1, "movies": [ … ] } }
```

注意：**沒有結果時 `data` 裡沒有 `movies` 這個鍵**（不是空陣列）。`status` 不是 `ok` 時，`status_message` 是原因。

### 單一電影

```
GET {base}/api/v2/movie_details.json?movie_id=<id>
```

回應是 `data.movie`，欄位和列表裡的每一部相同。

### 電影的欄位

只列用得到的。完整的形狀範例在 `reference/providers/yts.list_movies.sample.json`（值是示意，欄位名稱依查證結果）。

| YTS 欄位 | 用途 |
| --- | --- |
| `id` | 我們的 `ytsId` |
| `imdb_code` | `tt` 開頭。查 TMDB、YIFY Subtitles 都用它 |
| `title`、`title_english`、`year`、`runtime`、`rating`、`genres`、`summary`、`language` | 顯示。`runtime` 是分鐘，**可能是 0**（YTS 沒填）；這時預覽預留用 120 分鐘估 |
| `medium_cover_image` | 海報。由伺服器代抓 |
| `torrents[]` | 版本清單 |

每個版本（`torrents[]` 的一項）：

| YTS 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `hash` | 字串 | info hash，40 個十六進位字元，**大寫**。存進資料庫前轉小寫 |
| `quality` | 字串 | `720p`、`1080p`、`2160p`、`3D` |
| `type` | 字串 | `bluray` 或 `web` |
| `video_codec` | 字串 | `x264` 或 `x265` |
| `bit_depth` | **字串** | `"8"` 或 `"10"` |
| `audio_channels` | 字串 | `"2.0"` 或 `"5.1"` |
| `size_bytes` | 數字 | 接受下載時用這個值 |
| `size` | 字串 | 例如 `"1.6 GB"`，不要用它，自己從 `size_bytes` 格式化 |
| `seeds`、`peers` | 數字 | 是 YTS 上次統計的值，不是即時的 |
| `date_uploaded_unix` | 數字 | 秒 |
| `url` | 字串 | .torrent 檔的下載網址。**用不到**，我們只用 hash |

所有回應都用 zod 驗證。必要欄位（`id`、`imdb_code`、`title`、`year`、`torrents[].hash`、`torrents[].size_bytes`）缺了就把那一部或那個版本略過並記 log；整個回應不是預期的形狀（不是 JSON、是一個 HTML 頁面、`status` 欄位不存在）就回 `YTS_BAD_RESPONSE`，這通常表示網域已經不是 YTS 了。

### 類型

YTS 的類型是英文，查詢時用英文值，介面顯示中文。

| 值 | 顯示 | 值 | 顯示 | 值 | 顯示 |
| --- | --- | --- | --- | --- | --- |
| `action` | 動作 | `drama` | 劇情 | `mystery` | 懸疑 |
| `adventure` | 冒險 | `family` | 家庭 | `romance` | 愛情 |
| `animation` | 動畫 | `fantasy` | 奇幻 | `sci-fi` | 科幻 |
| `biography` | 傳記 | `film-noir` | 黑色電影 | `sport` | 運動 |
| `comedy` | 喜劇 | `history` | 歷史 | `thriller` | 驚悚 |
| `crime` | 犯罪 | `horror` | 恐怖 | `war` | 戰爭 |
| `documentary` | 紀錄片 | `music` / `musical` | 音樂 / 歌舞 | `western` | 西部 |

回應裡的 `genres` 是首字大寫的英文（`"Sci-Fi"`），顯示前用同一張表轉換（比對時不分大小寫）；表裡沒有的原樣顯示。查詢參數的大小寫要求請在階段 0 用真的 YTS 確認一次。

## 版本怎麼變成我們的 `Version`

```
directPlay   = video_codec == "x264" && bit_depth == "8"
previewBytes = directPlay ? 0 : 預覽預留(片長, 現在的設定)   見 10-storage.md
needBytes    = size_bytes + previewBytes
```

`directPlay` 在這裡只是預測，下載完成後由 ffprobe 的結果決定（見 [08-media-pipeline.md](08-media-pipeline.md)）。`previewBytes` 用的是查詢當下的設定（自動轉檔開不開、解析度）；真正按下載時再算一次，並且從那一刻起固定下來（D40）。

每個版本還要帶上本地的狀況（`local`）：系統裡有沒有這個 info hash 的下載、狀態、進度、誰持有、呼叫者自己有沒有。沒有的話算出現在放不放得下。

## 磁力連結

只用 hash 就能下載。交給 WebTorrent 的是：

```
magnet:?xt=urn:btih:<小寫 hash>&dn=<片名+年份+畫質,URL 編碼>&tr=<tracker 1>&tr=<tracker 2>…
```

tracker 清單是設定 `downloads.trackers`。預設值請取自 YTS API 文件當時列出的清單（拿到 YTS 網址後確認）。在那之前用下面兩個，它們在 2026-10-05 的階段 0 實測（`scripts/phase0/real-swarm.mjs`）有回應：

```
udp://tracker.opentrackr.org:1337/announce
udp://open.demonii.com:1337/announce
```

原本憑記憶寫的另外兩個已經不能用：`udp://tracker.openbittorrent.com:80` 查不到網域（`ENOTFOUND`），`udp://p4p.arenabg.com:1337` 逾時。

DHT 是開著的，所以 tracker 全部失效時通常還是找得到 peers，只是比較慢。階段 0 在 Docker bridge 網路裡實測：DHT 和 uTP 都正常，加入後 4 到 8 秒拿到種子資訊。

## 快取

存在 `provider_cache`，`provider = 'yts'`。存的是驗證、解析之後我們自己的形狀（電影資料和版本清單），不是 YTS 的原始回應。

| 內容 | 鍵 | 有效時間 |
| --- | --- | --- |
| 搜尋結果 | 參數組合 | 10 分鐘 |
| 單一電影 | `movie:<id>` | 60 分鐘 |

過期的列不會被清掉，只會在下次查到新資料時被覆寫。

**YTS 連不上時**：搜尋回 `YTS_UNREACHABLE`；單一電影如果有存過（不論多舊）就用存下來的那一份，回應裡 `stale` 是 true、`fetchedAt` 是那份資料的時間，電影頁據此顯示「這是先前存下來的資料」。這表示已經看過的電影頁在 YTS 掛掉時仍然能開、能下載：那些 hash 確實是從 YTS 來的，符合 D26。

## 海報

瀏覽器不直接連 YTS（D30）。

- `GET /api/yts/movies/:ytsId/poster` 由伺服器抓 `medium_cover_image` 再回傳，帶 `Cache-Control: private, max-age=86400`。
- 只抓主機等於 `yts.baseUrl` 的主機、或是它的子網域的圖片網址；其他的不抓，回 404。
- 回應必須是圖片（`image/jpeg`、`image/png`、`image/webp`），大小上限 2 MB。
- 電影被下載時，把海報存一份到 `/data/posters/<yts_id>.jpg`，之後從這裡讀。這樣 YTS 換網域也不影響片庫。
- 抓不到時，前端畫佔位海報：用片名算出一個固定的底色，上面寫片名和年份（原型就是這樣畫的）。

## 請求的規矩

- 逾時 10 秒。網路錯誤和 5xx 重試一次，其他不重試。
- `User-Agent` 用 `Paiban/<版本>`。
- 同時最多 4 個請求。
- 回應大小上限 5 MB。

## 測試連線

管理頁的「測試連線」呼叫 `list_movies.json?limit=1`。結果是 `SourceCheck`（`packages/shared/src/contracts/api.ts`）：

| 情況 | `code` | `data` |
| --- | --- | --- |
| 成功，回應是 YTS 的形狀 | `OK` | `{status: 200, count: 片庫的總片數}` |
| 還沒填網址 | `NOT_CONFIGURED` | |
| 被轉址到別的主機 | `REDIRECTED` | `{host: 目的地的主機}` |
| 連不上、逾時、5xx | `UNREACHABLE` | `{status}`（有的話） |
| 回應不是 YTS 的形狀 | `BAD_RESPONSE` | |

`ms` 是花了多久。介面上的句子由前端依代碼寫，例如「這個網域把請求轉到 yts.example。確認那是真的之後，再把設定改過去。」

## 開發與測試用的假 YTS

自動化測試和本機開發**不連真的 YTS**。請做一個假的 YTS（同樣的兩個端點、同樣的回應形狀），片單可以直接用原型裡那 14 部公有領域的老片（`prototype/platform/src/app1.js` 的 `MOVIES`）。其中一部的某個版本要對應到本機測試用的 torrent，讓整條流程能在沒有網路的情況下跑完。做法在 [15-testing.md](15-testing.md)。

## 電影資料改用 TMDB（Brian，2026-10-06）

YTS 只負責「有哪些片、有哪些版本可以下載」。人看到的電影資料改用 TMDB：用 YTS 給的 IMDb 編號呼叫一次 `GET /3/find/<imdb>?external_source=imdb_id&language=zh-TW`，拿到 TMDB 編號、中文片名、中文簡介、海報路徑和評分（`apps/server/src/tmdb/tmdb.ts`）。

- 結果存在 `provider_cache`（`tmdb`、`film:<imdb>`）一週；TMDB 不認得的片存一天。片子已經在資料庫時，順便寫入 `movies.tmdb_id` 和 `title_zh`，字幕來源就直接用 TMDB 編號。
- 搜尋頁一頁 24 部，快取以外的同時最多問 6 個，最多等 2.5 秒；沒等到的這次先用 YTS 的資料，答案照樣存進快取給下一次用。
- 評分：TMDB 有 5 票以上時用 TMDB 的，否則用 YTS 的 IMDb 評分。頁面上寫明來源。
- 海報：有 TMDB 海報就經由這個伺服器抓 `image.tmdb.org/t/p/w342/…`（瀏覽器不直接連 TMDB，D30），沒有才用 YTS 的封面。
- 沒有 TMDB 金鑰、或金鑰被拒時，全部退回 YTS 的資料；金鑰被拒會在來源設定的 TMDB 卡片顯示。
- IMDb 編號還是保留：YTS 和 YIFY Subtitles 只認得它。

