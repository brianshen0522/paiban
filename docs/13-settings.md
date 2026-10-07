# 13 設定

管理員在介面上調整的東西存在 `settings` 資料表（一項一列），金鑰存在 `secrets`。部署時決定的東西是環境變數，見 [02-architecture.md](02-architecture.md)。

API 的形狀是 `packages/shared/src/contracts/api.ts` 的 `Settings`、`SettingsInfo`。`PATCH /api/admin/settings` 只送要改的部分；任何一項不合法就整個拒絕，回 `SETTING_INVALID`，`details.fields` 指出是哪一項、什麼原因。每次成功的變更寫一筆 `admin.settings.change`（記改了哪些鍵，不記金鑰的內容）。

容量上限也存在 `settings` 資料表，但它不在 `Settings` 這個型別裡：它有自己的端點和驗證（`PUT /api/admin/storage/limit`），目前的值在 `Usage.limitBytes`。

## 設定項目

| 鍵 | 型別 | 預設 | 規則 | 在哪一頁 |
| --- | --- | --- | --- | --- |
| `storage.limitBytes` | 整數 | 由 `STORAGE_LIMIT_GB` 寫入一次 | 見 [10-storage.md](10-storage.md)。走專用的端點 `PUT /api/admin/storage/limit` | 儲存空間管理 |
| `downloads.maxActive` | 整數 | 2 | 1 到 5 | 下載設定 |
| `downloads.maxPerUser` | 整數 | 2 | 1 到 5，不能大於 `maxActive` | 下載設定 |
| `downloads.downloadLimitKB` | 整數 | 0 | 0 到 1,000,000。0 是不限。單位是每秒 KB（1024 位元組） | 下載設定 |
| `downloads.uploadLimitKB` | 整數 | 512 | 同上 | 下載設定 |
| `downloads.seedMode` | `stop` / `ratio` | `stop` | | 下載設定 |
| `downloads.stallMinutes` | 整數 | 30 | 5 到 240 | 下載設定（D37） |
| `downloads.trackers` | 字串陣列 | 見 [05-yts.md](05-yts.md) | 每一項是 `udp://`、`http://` 或 `https://` 開頭的網址；最多 20 項；可以是空的 | 下載設定（D37） |
| `media.analyzeAuto` | 布林 | true | | 下載設定 |
| `media.proxyAuto` | 布林 | true | | 下載設定 |
| `media.proxyResolution` | `480p` / `720p` | `480p` | | 下載設定 |
| `yts.baseUrl` | 字串 | 空 | `https://` 開頭，只有主機和可有可無的埠，沒有路徑；儲存時去掉結尾斜線；不能指向內部位址。開發和測試時（`ALLOW_LOCAL_SOURCES=1`）可以是 `http://` 和內部位址 | 來源設定 |
| `providers.cacheHours` | 整數 | 24 | 1 到 168 | 來源設定 |
| `providers.justsubtitles.enabled` | 布林 | true | | 來源設定 |
| `providers.justsubtitles.mode` | `direct` / `subdl` | `direct` | 切到 `subdl` 而沒有 SubDL 金鑰是允許的，但要提醒「已切換，但還沒有 SubDL 金鑰，查詢會失敗。」 | 來源設定 |
| `providers.yify.enabled` | 布林 | true | | 來源設定 |
| `providers.yify.baseUrl` | 字串 | `https://yts-subs.com` | 同 `yts.baseUrl` 的規則 | 來源設定 |
| `providers.assrt.enabled` | 布林 | true | | 來源設定 |
| `providers.zimuku.enabled` | 布林 | true | | 來源設定 |
| `providers.zimuku.searchUrl` | 字串 | 空 | 空的，或 `https://` 開頭而且含有 `{q}` | 來源設定（原型沒有這個欄位） |
| `subtitles.defaultLangs` | 語言陣列 | `zh-Hant`、`en` | 至少一項 | 來源設定的「共用設定」。原型只顯示、不能改；正式版做成可以勾選 |
| `align.asr` | 布林 | true | 之後分析的片子要不要做語音辨識（[08-media-pipeline.md](08-media-pipeline.md) 的「語音辨識」）。關掉不影響已經做好的 | 來源設定的「自動對齊」（新） |
| `llm.translatePerHour` | 整數 | 5 | 0 到 100。每人每小時最多開始幾次字幕翻譯（[18-llm.md](18-llm.md)）；0 表示不能開始新的翻譯 | LLM 設定頁（新） |

### 介面上的錯誤訊息

| 情況 | 文字 |
| --- | --- |
| `maxActive`、`maxPerUser` 超出範圍 | 請填 1 到 5 之間的整數。 |
| `maxPerUser` 大於 `maxActive` | 不能大於全站上限（2）。 |
| 限速不是 0 以上的整數 | 請填 0 以上的整數，0 表示不限。 |
| `stallMinutes` 超出範圍 | 請填 5 到 240 之間的整數。（新） |
| tracker 格式不對 | 第 3 行不是有效的 tracker 網址。（新） |
| 網址格式不對 | 請填完整的網址，以 https:// 開頭，例如 https://yts.example。（句尾的例子依欄位換：YIFY Subtitles 的欄位寫 https://yts-subs.com；字幕庫的欄位不舉例。`yts.example` 是保留給示範用的網域，只出現在這句說明裡，不會被當成預設值） |
| 網址指向內部位址 | 這個網址指向內部網路，不能使用。（新） |
| `cacheHours` 超出範圍 | 請填 1 到 168 之間的整數。 |
| 字幕庫的網址沒有 `{q}` | 網址裡要有 {q}，搜尋時會換成片名。（新） |
| 選了 OpenAI 相容卻沒填網址或模型（`REQUIRED`） | 選了 OpenAI 相容的服務時，這一欄必填。（新） |
| 模型服務的網址格式不對 | 請填完整的網址，以 http:// 或 https:// 開頭，例如 https://dashscope.aliyuncs.com/compatible-mode/v1。（新） |

標了「（新）」的是原型沒有的欄位或檢查，句子照同樣的語氣寫。

## 金鑰

| 名稱 | 用途 | 沒有設定時 |
| --- | --- | --- |
| `tmdbKey` | 搜尋和電影頁的中文片名、中文簡介、海報、評分（Brian，2026-10-06）；IMDb 編號換 TMDB 編號（JustSubtitles 需要）；射手網搜尋用的中文片名 | 片名、簡介是 YTS 的英文，海報是 YTS 的，評分是 YTS 給的 IMDb 評分（標「IMDb」）；JustSubtitles 改用片名比對（可能對不到）；射手網只用英文片名查 |
| `subdlKey` | JustSubtitles 的備援模式 | 備援模式不能用 |
| `assrtToken` | 射手網（偽） | 這個來源顯示「還沒設定」，其他來源不受影響 |

語言模型的金鑰不在這裡：每個 LLM 設定檔有自己的金鑰，存在 `llm_profiles`（[18-llm.md](18-llm.md)）。原本的 `llmKey` 和 `align.llm.*` 在升級時搬成第一個設定檔後刪除。

`PUT /api/admin/secrets/:name` 寫入，`DELETE` 清除。輸入框是密碼框；已經設定的顯示「已設定，留空表示不變」；儲存後提示「〈名稱〉已儲存。之後不會再顯示內容。」留空按儲存是「沒有輸入新的值，維持原設定。」

申請方式的說明文字：

- TMDB：「在 TMDB 帳號設定裡免費申請。」
- SubDL：「只有切到 SubDL 官方 API 時才會用到。」
- 射手網：「在射手網（偽）註冊後，從使用者面板取得。」
- 語言模型：「Claude 在 console.anthropic.com 申請；通義千問在阿里雲百鍊（DashScope）申請。只有字幕和片中語言不同時才會用到，每次自動對齊約十幾個請求。」

## 唯讀資訊（`SettingsInfo`）

| 項目 | 來源 | 顯示在 |
| --- | --- | --- |
| 哪些金鑰已設定 | `secrets` 有沒有那一列 | 來源設定 |
| 連入埠 | 環境變數 `TORRENT_PORT`、`TORRENT_DHT_PORT` | 下載設定的「連線」（D31）。說明：「這兩個埠寫在部署設定裡。Docker 和路由器都要開：〈埠〉（TCP 和 UDP）、〈DHT 埠〉（UDP）。沒開仍然能下載，只是比較慢。」（新：原型這裡是可以改的欄位） |
| 連入狀況 | `torrent` 的心跳 | 同上（D32）：「最近 24 小時內有外部連入」或「還沒觀察到外部連入」（新：原型這裡是一個測試按鈕） |
| 磁碟 | `/data` 的可用空間、系統保留、上限最大值 | 儲存空間管理、系統狀態 |

## 測試連線

`POST /api/admin/sources/:id/test`，`:id` 是 `yts`、`tmdb`、`justsubtitles`、`subdl`、`yify`、`assrt`。每個來源實際做什麼寫在 [05-yts.md](05-yts.md) 和 [07-subtitle-providers.md](07-subtitle-providers.md)。

這個端點一律回 200，內容是 `SourceCheck`：`{ok, code, data, ms}`。**它不回句子**；按鈕旁邊顯示的文字由前端依 `code` 和 `data` 寫。測試的結果同時更新那個來源的狀況（`SourceHealth`，總覽頁讀它）。按下去到結果回來之前，按鈕旁邊寫「測試中…」。

| `code` | 文字 | 用到的 `data` |
| --- | --- | --- |
| `OK`（YTS） | 回應 200 · 0.4 秒 | `status`；秒數來自 `ms` |
| `OK`（TMDB） | 金鑰有效 | |
| `OK`（JustSubtitles、SubDL） | 英文回傳 30 筆 | `count` |
| `OK`（YIFY Subtitles） | 網頁可以解析 | `rows` |
| `OK`（射手網） | 配額正常 | `quota` |
| `NOT_CONFIGURED` | 還沒設定網址。/ 還沒設定金鑰。 | |
| `INVALID_KEY` | 金鑰無效。 | |
| `UNREACHABLE` | 連不上。（原型模擬 YTS 連不上時寫的是「連線逾時」；正式版分不出逾時和其他連不上的原因，統一用這一句） | `status`（有的話） |
| `BAD_RESPONSE` | 回應的格式不對，這個來源可能改版了，或網址已經不是它了。 | |
| `REDIRECTED` | 這個網域把請求轉到 yts.example。確認那是真的之後，再把設定改過去。 | `host` |
| `RATE_LIMITED` | 超過使用額度，請稍後再試。 | `retryAfterSeconds`（有的話） |

`OK` 的五句是原型的寫法；其餘是新的。

## 設定什麼時候生效

| 設定 | 生效時機 |
| --- | --- |
| 容量上限 | 立刻。下一次 admission 就用新的值 |
| 同時下載數 | `torrent` 的下一輪（2 秒內）。**調低不會暫停已經在跑的**，只是在數量降下來之前不開始新的 |
| 限速 | `torrent` 的下一輪 |
| 做種方式 | 之後完成的下載。正在做種的在下一輪依新設定處理 |
| 停滯逾時、tracker | 之後開始的下載 |
| 自動分析 | 之後完成的下載。已經排入的分析照舊 |
| 自動轉預覽檔、解析度 | 之後**接受**的下載（D40）。已經在下載、已經完成的都照它們被接受時的設定走；已經做好的預覽檔不動。事後在工作台按「轉預覽檔」時，用的是當下的解析度 |
| YTS 網址、各來源的設定 | 立刻 |
| 快取時間 | 之後寫入的快取 |

`api` 讀設定時可以快取幾秒；`torrent` 每一輪重讀；`media` 每個工作開始時重讀。

## 個人偏好

存在 `users.prefs`，不是全站設定。原型的個人設定頁可以改這些偏好，但只有「簡體字幕自動轉成繁體」真的接上了行為；正式版四項都要照「說明」那一欄接上。

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `langs` | 建立帳號當時的 `subtitles.defaultLangs` | 字幕分頁的語言切換鈕預設選這些。至少一種 |
| `convertToTraditional` | true | 加入簡體字幕時自動轉成繁體（`POST /api/candidates/:id/add` 沒帶 `convertToTraditional` 時用它） |
| `secondLine` | false | 同步頁預設開著「同時顯示」；有英文字幕時選英文，沒有就選另一條 |
| `quality` | `1080p` | 電影頁的版本表裡，這個畫質的列做個標記。「只是在版本清單裡先標出來，不會自動下載。」 |

## 不開放設定的常數

放在 `packages/shared` 的一個檔案裡，集中管理、有註解，之後要開放再說。

| 常數 | 值 | 出處 |
| --- | --- | --- |
| 站名 | 拍板 / Paiban | D9。**使用者看得到的站名只在這裡**；對外請求的 `User-Agent`（`Paiban/<版本>`）也從這個常數組出來 |
| 搜尋每頁筆數 | 24 | [05-yts.md](05-yts.md) |
| 檢查點數量 | 8 | [09-sync-workbench.md](09-sync-workbench.md) |
| 自動對齊的搜尋範圍 | 60 秒 | [08-media-pipeline.md](08-media-pipeline.md) |
| 分數的顏色門檻 | 全片 0.70 / 0.55；單句 0.50 / 0.25 | 同上，尚未校正 |
| 上傳大小上限 | 20 MB | [07-subtitle-providers.md](07-subtitle-providers.md) |
| 解壓縮限制 | 200 個項目、總共 50 MB、單檔 10 MB | 同上 |
| 排名一次最多幾條 | 30 | 同上 |
| 來源請求的間隔 | JustSubtitles（含 SubDL）、YIFY Subtitles 1 秒；射手網 3.4 秒 | 同上 |
| 按「加入」時最多等抓檔多久 | 30 秒 | 同上 |
| 自動對齊的逾時 | ffsubsync 每次 20 秒；端點最多等 60 秒 | [08-media-pipeline.md](08-media-pipeline.md) |
| 背景工作失敗後自動再試 | 1 次（總共做 2 次） | 同上 |
| 候選字幕停在「處理中」多久算失敗 | 10 分鐘 | 同上（「對帳」） |
| 對帳的間隔 | 60 秒 | [02-architecture.md](02-architecture.md) |
| 種子比 YTS 列的大，不另外檢查空間的範圍 | 64 MB | [06-torrent-worker.md](06-torrent-worker.md) |
| 匯出檔名的長度上限 | 200 個字 | [11-pages.md](11-pages.md) |
| 預覽預留的位元率 | 見 [10-storage.md](10-storage.md) | |
| 匯出預留 | 原檔 × 1.01 + 1 MB | [10-storage.md](10-storage.md) |
| 用量指示的門檻 | 剩 2 GB 變黃、0.5 GB 變紅 | 原型 |
| 總覽的「磁碟快滿了」（`DISK_LOW`） | 磁碟可用空間少於系統保留的兩倍 | 2026-10-06 定（docs/changes.md） |
| Session 有效期 | 30 天 | [12-auth.md](12-auth.md) |
| 邀請連結有效期的選項 | 1、3、7 天 | 原型 |
| 重設連結有效期 | 30 分鐘 | 原型 |
| 自動儲存的延遲 | 1.5 秒 | [09-sync-workbench.md](09-sync-workbench.md) |
| 復原步數 | 100 | 原型 |
