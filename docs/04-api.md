# 04 API

每個端點的請求和回應**形狀**寫在 `packages/shared/src/contracts/api.ts`（用 TypeScript 7 的 strict 模式檢查過）。這份文件說明每個端點的**行為**：誰能呼叫、做了什麼、會回哪些錯誤。兩邊要一起改；真的對不上時，行為以這份文件為準，形狀以合約為準。

## 共通規則

- 所有端點都在 `/api` 底下，JSON，UTF-8。
- 大小一律是整數位元組；時間是 ISO 8601 的 UTC 字串；片長、字幕時間是秒（浮點數）。把位元組變成「1.6 GB」是前端的事。
- **API 不產生給人看的句子。** 它回代碼和資料（片名、檔名、版本名稱、數字），介面上的中文由前端依代碼組出來。唯一的自由文字是 `ApiError.message` 和 `Torrent.error.message`，都是英文，給 log 和管理員看，不直接顯示。
- 登入狀態靠 cookie（細節在 [12-auth.md](12-auth.md)）。
- 除了下面標「公開」的端點，其他都要登入；沒登入回 `401 UNAUTHENTICATED`。
- 標「管理員」的端點，成員呼叫回 `403 FORBIDDEN`。
- 標「持有人」的端點，呼叫者必須是那部片的持有人，否則回 `403 NOT_HOLDER`。**管理員也一樣**：他要處理別人的片，先把那個版本加入自己的片庫（`POST /api/torrents`）。字幕和影片的端點依它所屬的那部片檢查。管理員比成員多的只有三樣：`/api/admin/…`、全站的下載與匯出清單（`scope=all`）、任何人的匯出檔。
- 正在被刪除的下載（`want = 'remove'`）對所有端點來說已經不存在：回 `404 NOT_FOUND`，清單裡也不列出。
- 會改變資料的請求（`POST`、`PUT`、`PATCH`、`DELETE`）必須帶 `X-Requested-With: paiban` 標頭，並檢查 `Origin` 和 `PUBLIC_URL` 同源（或等於請求的 `Host`）；少了就回 `403 FORBIDDEN`。這是防跨站請求用的。有內容的請求另外要帶 `Content-Type: application/json`（上傳是 `multipart/form-data`）；沒有內容的請求（例如暫停、刪除）不需要 `Content-Type`。
- `GET` 不改變資料。有兩個例外，都只是紀錄，不是使用者的資料：`sessions.last_seen_at` 和 `torrents.last_used_at`。
- 請求內容不符合 schema 回 `422 VALIDATION`，`details.fields` 指出哪個欄位、什麼原因（原因是代碼，不是句子）。
- 錯誤回應的形狀固定是 `ApiError`。

## 端點

### 健康檢查

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `GET /api/health` | 公開 | 資料庫連得上就回 `{ok: true}`。給 compose 的 healthcheck 用，不透露其他資訊 |

### 登入與帳號

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `POST /api/auth/login` | 公開 | 帳號不分大小寫。成功就建立 session 並設 cookie。帳密錯誤一律回 `INVALID_CREDENTIALS`，不區分是帳號還是密碼錯；帳號停用回 `ACCOUNT_DISABLED`；嘗試太多次回 `RATE_LIMITED` |
| `POST /api/auth/logout` | 登入 | 刪除目前的 session |
| `GET /api/auth/me` | 登入 | 目前的使用者、站名、上傳大小上限、檢查點數量、全站同時下載數。前端啟動時呼叫它來判斷有沒有登入 |
| `GET /api/invites/:code` | 公開 | 註冊頁用來先檢查邀請碼。`INVITE_NOT_FOUND`、`INVITE_EXPIRED`、`INVITE_USED` |
| `POST /api/auth/register` | 公開 | 用邀請碼建立帳號並直接登入。邀請碼在同一個交易裡標成已使用。`USERNAME_TAKEN`、三種邀請碼錯誤、`VALIDATION` |
| `GET /api/auth/reset/:token` | 公開 | 檢查重設連結還有沒有效，回傳帳號名稱給頁面顯示。`RESET_INVALID` |
| `POST /api/auth/reset/:token` | 公開 | 設定新密碼，連結失效，這個帳號的所有 session 全部登出 |
| `PATCH /api/me` | 登入 | 改顯示名稱或偏好。`prefs.langs` 至少要有一個 |
| `POST /api/me/password` | 登入 | 要帶目前的密碼（錯了回 `WRONG_PASSWORD`）。成功後其他裝置全部登出 |
| `GET /api/me/sessions` | 登入 | 登入中的裝置。作業系統和瀏覽器的名稱從登入時的 User-Agent 推出來，推不出來是 null |
| `DELETE /api/me/sessions/:id` | 登入 | 登出那台裝置。不能用來登出目前這台（用 logout）；硬要的話回 `VALIDATION` |

### 搜尋

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `GET /api/yts/movies` | 登入 | 轉呼叫 YTS 的 `list_movies`。沒有 `q` 時就是「最新上架」。每頁 24 部。結果快取 10 分鐘。還沒設定 YTS 的網址回 `YTS_NOT_CONFIGURED`，連不上回 `YTS_UNREACHABLE`，回應看不懂回 `YTS_BAD_RESPONSE`。每一部標上呼叫者有沒有（`mine`） |
| `GET /api/yts/movies/:ytsId` | 登入 | 電影資料加上每個版本。每個版本附上：能不能直接播、要預留多少預覽空間、總共需要多少、現在放不放得下、系統裡是不是已經有人下載。同時回目前的用量。YTS 連不上而這部片有先前存下來的資料時照常回傳，`stale` 是 true，`fetchedAt` 是那份資料的時間；沒有存過才回 `YTS_UNREACHABLE` |
| `GET /api/yts/movies/:ytsId/poster` | 登入 | 由伺服器向 YTS 取海報再回傳。片庫裡的電影從 `/data/posters` 讀。取不到回 404，前端改畫佔位海報 |

細節在 [05-yts.md](05-yts.md)。

### 下載

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `POST /api/torrents` | 登入 | 見下方「接受下載」 |
| `GET /api/torrents` | 登入 | `scope=mine`（預設）回自己持有的全部下載，不論狀態；`scope=all` 回全站的，只有管理員能用 |
| `GET /api/torrents/:id` | 持有人 | |
| `POST /api/torrents/:id/pause` | 持有人 | 只有 `queued`、`downloading` 能暫停，其他回 `TORRENT_STATE`。空間繼續保留 |
| `POST /api/torrents/:id/resume` | 持有人 | 只有 `paused` 能繼續。回到佇列尾端 |
| `POST /api/torrents/:id/retry` | 持有人 | 只有 `failed` 能重試。重新檢查空間：需求是完整大小加預覽預留，扣掉已經在磁碟上的殘留；不夠回 `STORAGE_LIMIT`。通過後回到佇列尾端，從已下載的部分接續 |
| `DELETE /api/torrents/:id/hold` | 持有人 | 把自己從持有人移除。還有別人持有：`{deleted: false, freedBytes: 0}`。自己是最後一位：整個下載連同字幕和預覽檔排入刪除，`{deleted: true, freedBytes}`。匯出檔不受影響 |

**接受下載**（`POST /api/torrents`），依序：

1. 還沒設定 YTS 的網址回 `YTS_NOT_CONFIGURED`。用 `ytsId` 向 YTS（或快取）取這部片的資料，確認 `infoHash` 在它的版本清單裡。不在就回 `HASH_NOT_FROM_YTS`。**大小、畫質、編碼一律用伺服器這邊查到的，不採用請求裡的任何其他值。**
2. 在交易裡找這個 info hash 的列並鎖住它：
   - 存在，但正在被刪除（`want = 'remove'`）：回 `TORRENT_STATE`。介面請使用者稍後再試。
   - 存在：把呼叫者加入持有人，回 `{torrent, joined: true}`。不檢查空間。如果它是 `failed`，不自動重試；加入之後他可以自己按重試。
3. 不存在：算出需求（影片大小 + 預覽預留）。預覽預留依**當時**的設定算，要不要轉預覽影片、轉成什麼解析度也一併定下來（D40）。在同一個交易裡呼叫 `storage_admit`。不夠回 `STORAGE_LIMIT`，`details` 帶需求、剩餘、差額、其中預覽佔多少。磁碟本身的可用空間不夠回 `DISK_FULL`。
4. 通過：建立電影（沒有的話）、下載、持有人，回 `{torrent, joined: false}`，通知 `torrent`。

### 片庫

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `GET /api/library` | 登入 | 自己持有且已經下載完成的片（包含還在分析的），每一筆帶字幕與匯出的數量和「下一步」。篩選在前端做 |
| `GET /api/library/:torrentId` | 持有人 | 工作區一次要用到的東西：這部片、它的字幕、它的匯出檔、目前用量、匯出一次需要多少空間。還沒下載完成的回 `MEDIA_NOT_READY`。**它不會啟動分析**：自動分析關掉時，前端看到 `analysis` 是 `none`，自己呼叫一次 `POST /api/media/:id/analyze` |

### 影片

`:id` 是 `media_files.id`。

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `GET /api/media/:id` | 持有人 | 各項資產的狀態、最近的錯誤、預覽檔佔多少、補做預覽檔要多少，以及工作台該用哪個來源（見 [09-sync-workbench.md](09-sync-workbench.md)） |
| `GET /api/media/:id/original` | 持有人 | 原始檔。支援 Range |
| `GET /api/media/:id/proxy` | 持有人 | 預覽檔。沒有就 404 |
| `GET /api/media/:id/audio` | 持有人 | 聲音檔。沒有就 404 |
| `GET /api/media/:id/peaks` | 持有人 | 波形的二進位檔。分析在等待或進行中回 `MEDIA_NOT_READY`；分析結束了但沒有這個檔案（失敗，或從來沒要求過）回 404 |
| `GET /api/media/:id/speech` | 持有人 | 人聲區段。同上 |
| `POST /api/media/:id/analyze` | 持有人 | 排入分析：`analysis` 是 `none` 或 `failed` 時把它設成 `pending`（探測失敗過的話，連探測也重做）。已經在等待、進行中或完成就直接回現況 |
| `POST /api/media/:id/proxy` | 持有人 | 要求預覽資產。能直接播的檔案直接回現況。否則把聲音檔和預覽影片當中是 `none` 或 `failed` 的都設成 `pending`（預覽影片的解析度用現在的設定），兩者的預留量加起來過一次 admission，不夠回 `STORAGE_LIMIT`。探測失敗過的話，連探測也重做。沒有缺的就直接回現況 |

串流端點的要求：支援 `Range`、`If-Range`、`HEAD`，回 `Accept-Ranges: bytes`，`Cache-Control: private, no-store`。`Content-Type` 依容器：`video/mp4`、`video/x-matroska`、`video/webm`；聲音檔是 `audio/mp4`。檔案路徑只從資料庫來，不接受請求裡的任何路徑片段。

### 字幕

`:id` 在 `/api/torrents/:id/...` 是下載的 id，在 `/api/subtitles/:id` 是字幕的 id，在 `/api/candidates/:id` 是候選的 id。

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `GET /api/torrents/:id/candidates` | 持有人 | 各來源的狀態、候選清單、排名是否進行中、字幕庫的搜尋連結 |
| `POST /api/torrents/:id/subtitle-search` | 持有人 | 替每個啟用的來源排入一次查詢，**立刻回傳**（各來源是 `running`）。每個來源完成時發 `candidates` 事件。帶 `provider` 時只查那一個。有還沒過期的快取就用快取；`refresh: true` 略過快取（「重新搜尋」和「重試」都帶它） |
| `POST /api/torrents/:id/candidates/rank` | 持有人 | 把所選語言的候選（最多 30 條）都抓下來並自動對齊一次，依分數排名。選了繁體中文時，這部片所有中文的候選都算在內。立刻回傳，進度靠 `candidates` 事件。沒有人聲資料（分析還沒好，或分析失敗了）回 `MEDIA_NOT_READY`；介面在這種情況下本來就把按鈕停用並說明原因。已經有一次排名在跑就直接回現況，不重複啟動 |
| `POST /api/torrents/:id/uploads` | 持有人 | 上傳一個字幕檔或壓縮檔，上限 20 MB。副檔名不對回 `UNSUPPORTED_FILE`，太大回 `UPLOAD_TOO_LARGE`。檔案一收到，清單上就多一條「處理中」的候選；內容在背景處理，讀不了的話那條候選變成失敗並帶原因（`fetchError`） |
| `POST /api/candidates/:id/add` | 持有人 | 把候選加入這部片。還沒抓檔的先抓，**最多等 30 秒**。抓不到回 `CANDIDATE_UNAVAILABLE`，`details.reason` 是原因：候選的 `fetchError`，或 `TIMEOUT`（背景還在抓，晚一點再按一次）。`convertToTraditional` 沒給就用呼叫者的偏好。內容和既有字幕完全相同回 `SUBTITLE_DUPLICATE` |
| `DELETE /api/candidates/:id` | 持有人 | 把一條候選從清單拿掉，連同它抓下來的檔案。主要用來清掉失敗的上傳。已經加入的字幕不受影響 |
| `GET /api/torrents/:id/subtitles` | 持有人 | 這部片已加入的字幕 |
| `GET /api/subtitles/:id` | 持有人 | 字幕、句子清單、同步文件 |
| `PUT /api/subtitles/:id/doc` | 持有人 | 儲存同步文件。`rev` 和資料庫裡的不一樣就回 `REVISION_CONFLICT`，`details` 帶目前的 `rev`、`doc` 和最後修改的人。`segments` 或 `edits` 和資料庫裡的不同時，狀態變回草稿；只動到對齊點或檢查點不會。每次儲存都重算分數，並通知其他持有人的畫面。帶 `reason`（`auto-align` 或 `reset`）時另外存一份歷史 |
| `POST /api/subtitles/:id/auto-align` | 持有人 | 算出建議的分段並回傳，**不會改動儲存的文件**（由前端套用後再存，這樣才能復原）。沒有人聲資料回 `MEDIA_NOT_READY`。工作通常 1 到 5 秒，端點等它完成才回應；兩種方法都失敗、或 60 秒內沒有結果，回 `ALIGN_FAILED` |
| `POST /api/subtitles/:id/confirm` | 持有人 | `rev` 要是最新的（不是的話回 `REVISION_CONFLICT`）。還有檢查點沒通過時，要帶 `force: true` 才接受（前端會先問使用者）；沒帶就回 `VALIDATION`，`details.fields` 是 `{force: 'CHECKPOINTS_PENDING'}`。成功後狀態是已確認，存一份歷史，通知其他持有人 |
| `GET /api/subtitles/:id/file` | 持有人 | 下載字幕檔（SRT、UTF-8）。`synced=true` 是套用同步文件之後的版本，否則是原始時間 |
| `DELETE /api/subtitles/:id` | 持有人 | 刪掉這條字幕和它的同步結果。已經匯出的 MKV 不受影響 |

來源的細節在 [07-subtitle-providers.md](07-subtitle-providers.md)，同步文件在 [09-sync-workbench.md](09-sync-workbench.md)。

### 匯出

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `POST /api/torrents/:id/exports` | 持有人 | 至少一條字幕，而且每一條都要是已確認的（否則 `NO_CONFIRMED_SUBTITLE`）；恰好一條是預設軌；檔名要通過檢查（否則 `INVALID_FILENAME`）。要通過 admission（否則 `STORAGE_LIMIT`） |
| `GET /api/exports` | 登入 | `scope=mine`（預設）回自己建立的；`scope=all` 回全站的，只有管理員能用。儲存空間頁用它列出「我建立的匯出檔」：電影被刪掉之後，匯出檔只剩這裡可以下載。某一部片的匯出檔在 `GET /api/library/:torrentId` 裡 |
| `GET /api/exports/:id/file` | 那部片的持有人、建立者或管理員 | 下載 MKV。支援 Range，帶 `Content-Disposition: attachment` |
| `DELETE /api/exports/:id` | 建立者或管理員 | 完成或失敗的：刪檔、刪列。還在排隊的：直接刪。進行中的：要求取消，`media` 停下來之後刪。回釋出的大小 |

細節在 [08-media-pipeline.md](08-media-pipeline.md)。

### 儲存空間、通知、即時更新

| 端點 | 權限 | 行為 |
| --- | --- | --- |
| `GET /api/storage` | 登入 | 全站用量（所有人看到的數字相同），加上呼叫者自己持有的項目（影片、下載中的預留、失敗的殘留、預覽檔）。自己建立的匯出檔另外從 `GET /api/exports` 拿 |
| `GET /api/notifications` | 登入 | 最近 50 則和未讀數 |
| `POST /api/notifications/read` | 登入 | 標成已讀 |
| `GET /api/events` | 登入 | Server-Sent Events，見下方 |

### 管理

全部限管理員。

| 端點 | 行為 |
| --- | --- |
| `GET /api/admin/overview` | 總覽頁的全部資料：用量、下載數、使用者數、背景工作、需要處理的事、各來源狀況、最近的操作 |
| `GET /api/admin/users` | 每位使用者，含持有幾部、幾個下載進行中、獨自持有幾個項目 |
| `PATCH /api/admin/users/:id` | 改角色或停用。不能對自己做（回 `FORBIDDEN`）；不能讓系統沒有任何啟用中的管理員（`LAST_ADMIN`）。停用會立刻登出他的所有裝置 |
| `POST /api/admin/users/:id/reset-link` | 產生一次性的重設連結，30 分鐘有效。連結只在這次回應裡出現 |
| `DELETE /api/admin/users/:id` | 移除帳號。他持有的檔案不動（見 [03-data-model.md](03-data-model.md)）。不能移除自己（`FORBIDDEN`）；同樣受 `LAST_ADMIN` 限制 |
| `GET /api/admin/invites` | |
| `POST /api/admin/invites` | 有效期 1、3 或 7 天 |
| `DELETE /api/admin/invites/:id` | 撤銷（還沒用的）或清除（已用或過期的） |
| `GET /api/admin/storage` | 用量、磁碟資訊、**所有**項目（由大到小）、最近一次重新計算發現的孤兒與遺失（`findings`）、那一次重新計算的工作 |
| `PUT /api/admin/storage/limit` | 見 [10-storage.md](10-storage.md) 的驗證規則。低於目前用量是允許的 |
| `POST /api/admin/storage/rescan` | 排入一次重新計算，立刻回傳那個工作。已經有一次在跑就回那一個。做完時發 `admin` 事件（`storage`），頁面再抓一次 `GET /api/admin/storage`。**只更新數字和回報，不刪任何東西** |
| `DELETE /api/admin/storage/items/:kind/:id` | 強制刪除一個項目，不論誰持有。`movie`、`reserved`、`partial` 用下載的 id；`preview` 用影片的 id（只刪預覽影片和聲音檔）；`export` 用匯出的 id；`orphan` 用那一筆發現的 id（刪掉那個資料夾）。受影響的人會收到通知 |
| `GET /api/admin/settings` | 全部設定，加上唯讀資訊（哪些金鑰已設定、連入埠、磁碟）和各個來源最近的狀況 |
| `PATCH /api/admin/settings` | 只送要改的部分。任何一項不合法就整個拒絕（`SETTING_INVALID`），`details.fields` 指出是哪一項 |
| `PUT /api/admin/secrets/:name` | 寫入一把金鑰。之後不會再顯示 |
| `DELETE /api/admin/secrets/:name` | 清除 |
| `POST /api/admin/sources/:id/test` | 實際連一次那個來源。**一律回 200**：連不上是測試的結果，不是這個端點的錯誤。回 `{ok, code, data, ms}`，並更新那個來源的狀況 |
| `GET /api/admin/system` | 各服務的心跳、最近 50 個背景工作、磁碟資訊 |
| `POST /api/admin/tasks/:id/retry` | 重跑一個失敗的工作。只適用於分析、預覽資產、重新計算（`Task.retryable`）；預覽資產要重新通過 admission，不夠回 `STORAGE_LIMIT`。對齊、排名、匯出不能這樣重跑（回 `VALIDATION`）：對齊和排名由使用者再按一次，匯出重新建立一個 |
| `GET /api/admin/audit` | 操作紀錄，每頁 50 筆，用 `before` 往前翻 |

## 即時更新

`GET /api/events` 是一條 Server-Sent Events 連線。每則訊息是一個 `ServerEvent` 的 JSON。

- 連線建立後先送一則註解（`: ok`），之後每 25 秒送一次心跳註解，避免中間的代理把連線關掉。
- 事件只送給有權看到那筆資料的人：下載、候選、字幕的事件送給持有人（管理員的下載頁勾了「顯示所有人的下載」時靠重新抓清單更新，不另外推送）；匯出的事件送給那部片的持有人和建立者；`usage` 送給所有人；`notification` 只送給當事人；`admin` 只送給管理員。
- 兩個例外：`torrent.removed` 和 `export.removed` 送給所有人。通知到的時候那一列和它的持有人名單已經不在了，沒辦法再查該送給誰；事件裡只有一個 id，不透露任何內容，用戶端手上沒有那個 id 就忽略。
- **進度的頻率**：同一個下載每秒最多一則 `torrent` 事件。`torrent` 程式每 2 秒把進度寫進資料庫一次，所以畫面大約每 2 秒更新一次。
- 事件是「提醒」，不是唯一的資料來源。斷線重連後，前端重新抓一次目前畫面需要的資料，不依賴補送。

前端的做法：收到事件就更新 TanStack Query 的快取（帶完整資料的事件直接寫入，只帶 id 的就讓對應的查詢失效）。

### 伺服器之間的通知

`api` 靠 `LISTEN paiban_events` 得知其他服務做了什麼。`NOTIFY` 的內容只有 `{type, id}`，資料由 `api` 自己查。`api` 自己造成的變動（例如儲存同步文件）不經過這裡，直接發事件。

| `type` | `id` | 誰發 | `api` 收到後 |
| --- | --- | --- | --- |
| `torrent` | 下載 | torrent、media | 讀出那個下載（含影片各項資產的狀態）→ `torrent` 事件。分析和預覽檔的進度也是走這一則 |
| `torrent.removed` | 下載 | torrent | `torrent.removed` 事件 |
| `candidates` | 下載 | media | `candidates` 事件。`api` 自己處理的查詢工作做完時直接發這個事件，不繞一圈 |
| `export` | 匯出 | media、torrent | `export` 事件。`torrent` 只在一種情況發：電影被移除，它把還沒做完的匯出標成失敗的時候 |
| `export.removed` | 匯出 | media | `export.removed` 事件 |
| `task` | 工作 | media、torrent | 叫醒正在等這個工作結果的請求；`admin` 事件（`tasks`） |
| `notification` | 通知 | torrent、media | `notification` 事件，送給那則通知的對象 |
| `usage` | （空） | torrent、media | 重算用量 → `usage` 事件 |
| `storage` | （空） | media | 重新計算做完了：`admin` 事件（`storage`）和 `usage` 事件 |

會改變用量的動作（完成、失敗、刪除、預覽檔做好、匯出完成）除了自己的那一則，都再發一則 `usage`。服務的心跳不經過通知；系統狀態頁開著的時候每 10 秒重新抓一次。

## 錯誤碼

| 代碼 | HTTP | 什麼時候 | 介面怎麼處理 |
| --- | --- | --- | --- |
| `UNAUTHENTICATED` | 401 | 沒登入或 session 失效 | 回登入頁，登入後回到原本的頁面 |
| `INVALID_CREDENTIALS` | 401 | 帳號或密碼不對 | 登入表單裡顯示「帳號或密碼不正確。」 |
| `FORBIDDEN` | 403 | 不是管理員；或少了防跨站的標頭 | 「這一頁只有管理員能看。」 |
| `ACCOUNT_DISABLED` | 403 | 帳號被停用 | 「這個帳號已被停用，請聯絡管理員。」 |
| `NOT_HOLDER` | 403 | 不是這部片的持有人 | 當成找不到頁面 |
| `NOT_FOUND` | 404 | | 「找不到這個頁面。它可能已經被刪除。」 |
| `INVITE_NOT_FOUND` | 404 | | 邀請碼欄位下方：「找不到這個邀請碼，請確認有沒有打錯。」 |
| `INVITE_EXPIRED` | 410 | | 「這個邀請碼已經過期，請管理員再給你一個新的。」 |
| `INVITE_USED` | 410 | | 「這個邀請碼已經用過了。」 |
| `RESET_INVALID` | 410 | 重設連結過期或用過 | 請對方找管理員再產生一次 |
| `USERNAME_TAKEN` | 409 | | 帳號欄位下方：「這個帳號已經有人用了。」 |
| `LAST_ADMIN` | 409 | 會讓系統沒有管理員 | 說明至少要留一位管理員 |
| `STORAGE_LIMIT` | 409 | 超過容量上限 | 在按鈕旁邊說明需要多少、剩多少、差多少，給「前往儲存空間」 |
| `DISK_FULL` | 507 | 磁碟本身沒空間了（上限還沒到） | 同上，另外說明這是磁碟的問題，請管理員處理 |
| `TORRENT_STATE` | 409 | 這個狀態不能做這個動作；或這個版本正在被刪除 | 重新整理那一列，通常不需要訊息。下載時遇到：「這個版本正在刪除中，請稍後再試。」 |
| `MEDIA_NOT_READY` | 409 | 下載還沒完成；或需要的分析資料還沒有（還在分析，或分析失敗了） | 顯示進度、「稍後再試」，或說明分析失敗並給「重新分析」 |
| `SUBTITLE_DUPLICATE` | 409 | 內容相同的字幕已經加入過 | 「這條字幕已經加入過了。」 |
| `REVISION_CONFLICT` | 409 | 別人先存了 | 見 [09-sync-workbench.md](09-sync-workbench.md) 的「兩個人同時改」 |
| `YTS_NOT_CONFIGURED` | 409 | 還沒有設定 YTS 的網址 | 搜尋頁的引導，見 [11-pages.md](11-pages.md) |
| `UPLOAD_TOO_LARGE` | 413 | | 說明上限 |
| `UNSUPPORTED_FILE` | 415 | | 「不支援這種檔案。請上傳 .srt、.ass、.vtt，或 .zip、.rar、.7z 壓縮檔。」 |
| `VALIDATION` | 422 | 欄位不合法 | 在各欄位下方顯示，焦點移到第一個錯的欄位 |
| `WRONG_PASSWORD` | 422 | 改密碼時目前的密碼不對 | 「目前的密碼不正確。」 |
| `HASH_NOT_FROM_YTS` | 422 | info hash 不在那部片的版本清單裡 | 正常操作不會遇到。重新整理電影頁 |
| `CANDIDATE_UNAVAILABLE` | 422 | 候選字幕的檔案抓不到或讀不了 | 依 `details.reason` 說明，見 [11-pages.md](11-pages.md) |
| `NO_CONFIRMED_SUBTITLE` | 422 | 匯出時沒選字幕，或選了還沒確認的 | 「至少要選一條已確認的字幕。還沒有的話，先去同步。」 |
| `INVALID_FILENAME` | 422 | | 檔名欄位下方說明規則 |
| `SETTING_INVALID` | 422 | | 在對應的欄位下方顯示 |
| `RATE_LIMITED` | 429 | 登入嘗試太多次 | 說明要等多久 |
| `ALIGN_FAILED` | 500 | 自動對齊的兩種方法都失敗，或逾時 | 訊息列：「自動對齊沒有成功。可以再試一次，或用對齊點手動對。」 |
| `YTS_UNREACHABLE` | 502 | 連不上 YTS | 搜尋頁的錯誤狀態，見 [11-pages.md](11-pages.md) |
| `YTS_BAD_RESPONSE` | 502 | YTS 回了看不懂的東西（很可能是冒牌站） | 同上，另外提醒檢查網址 |
| `INTERNAL` | 500 | 沒預料到的錯誤 | 「發生錯誤，請再試一次。」log 裡要有完整資訊 |

不會變成 HTTP 錯誤的失敗：

- 字幕搜尋時個別來源的失敗，寫在那個來源的 `ProviderStatus.error` 裡，其他來源照常回傳。
- 候選字幕抓檔失敗，寫在 `Candidate.fetchError`。
- 分析、預覽資產的失敗，寫在 `MediaStatus.errors`（每種資產一格）。
- 下載的失敗，寫在 `Torrent.error`。
- 管理頁測試來源的結果，寫在回應的 `ok` 和 `code`。
