# 06 下載程式（torrent）

`torrent` 是一個獨立的 Node 程式，裡面跑一個 WebTorrent 用戶端。它不提供任何 HTTP 介面，也不碰工作佇列；它讀資料庫裡的「希望狀態」，讓實際狀態跟上，再把進度寫回資料庫。

## 已經實測過的 WebTorrent 行為

`reference/torrent/local-swarm-test.mjs` 是一個不需要網路的測試：一個用戶端在本機做種一個檔案，另一個只憑 info hash 把它下載回來。它在 Node 22.22 和 24.21 上都通過，確認了下面每一項。**實作前先在目標映像檔裡跑一次。**

| 行為 | 結果 |
| --- | --- |
| 版本 | `webtorrent` 3.0.21，純 ESM，要求 Node 22 以上。原生模組（uTP、WebRTC）在兩個 Node 版本都載入成功 |
| 只給 info hash 就能加入 | 可以。種子資訊（檔名、大小、分塊）由 peer 提供，拿到時觸發 `metadata` |
| `torrent.addPeer()` | **必須等 `infoHash` 事件之後才能呼叫**，否則丟例外 |
| 限速 | `downloadLimit` / `uploadLimit`（位元組/秒，-1 是不限）在建立用戶端時給；執行中用 `client.throttleDownload(rate)` / `client.throttleUpload(rate)` 改 |
| `torrent.pause()` | **不是真的暫停**：它只停止連新的 peer，現有連線照樣下載（官方文件也這樣寫） |
| 真正的暫停 | 記下 `torrent.bitfield.buffer` → `torrent.destroy({ destroyStore: false })`。檔案留在磁碟上 |
| 接續下載 | 在新的用戶端用 `client.add(hash, { path, bitfield })`。768 個分塊的檔案 60 毫秒就 `ready`，已經有的分塊不重抓；WebTorrent 會抽驗每個檔案的一個分塊，不對才整個重驗 |
| 已完成的再加入 | `client.add(hash, { path, skipVerify: true })` 立刻 `ready` 而且 `done` 是 true（做種用） |
| 刪除檔案 | `client.remove(hash, { destroyStore: true })` 會把檔案刪掉 |
| 磁碟配置 | **不會預先配置完整大小**。下載到 35% 時檔案只有 8.9 MB（總共 24 MB）。所以「佔位」是資料庫裡的數字，不是磁碟上的空檔案 |

## 用戶端設定

```js
new WebTorrent({
  torrentPort: TORRENT_PORT,        // TCP 與 uTP(UDP)
  dhtPort: TORRENT_DHT_PORT,        // DHT(UDP)
  natUpnp: false, natPmp: false,    // 在容器裡沒有意義,埠由 compose 和路由器開
  lsd: false,                       // 區域網路探索,在 bridge 網路裡沒有用
  downloadLimit, uploadLimit,       // 來自設定,0 換成 -1
  maxConns: 55,                     // 每個下載的連線數上限,WebTorrent 的預設值
})
```

`client.on('error')` 是致命錯誤（例如埠被佔用）：記 log 後結束程式，讓 Docker 重啟它。

## 主迴圈：讓實際狀態跟上希望狀態

每 2 秒跑一次，收到 `NOTIFY paiban_torrent` 時立刻跑一次。每一輪：

1. 讀設定，限速有變就套用。放在最前面：放在最後時，這一輪剛排程開始的下載在套用之前完全不限速，小檔案可能一下子就下載完（2026-10-06 從一個時好時壞的測試找到）。
2. 讀出所有 `want = 'remove'` 的列 → 執行「移除」。
3. 讀出 `want = 'pause'` 而 `state` 是 `queued` 或 `downloading` 的列 → 執行「暫停」。
4. 讀出 `want = 'run'` 而 `state = 'paused'` 的列 → 把 `state` 改成 `queued`，`queued_at` 改成現在（回到隊伍尾端）。
5. 排程：見下一節。
6. 對每個進行中的下載：寫進度、檢查有沒有停滯。

每一步更新資料庫時都帶條件（`where id = $1 and state = '…' and want = '…'`）。影響 0 列表示情況在這一輪之間變了，下一輪再處理。整個迴圈要能重入：任何一步做到一半程式當掉，重啟後從資料庫的狀態重新開始都要是對的。

## 排程

兩個設定：`downloads.maxActive`（全站同時下載幾部，1 到 5）和 `downloads.maxPerUser`（每人同時幾部，不超過前者）。

```
進行中 = state = 'downloading' 的數量
候選   = state = 'queued' 且 want = 'run',依 queued_at 由舊到新
對每個候選:
  進行中 >= maxActive                        → 停止
  發起人(requested_by)已有 maxPerUser 個進行中 → 跳過,看下一個
  否則                                        → 開始下載,進行中 + 1
```

做種中的（已完成）不佔名額。

發起人的帳號已經不在（`requested_by` 是空的），或他已經不是這個下載的持有人：這個下載只受全站上限限制，不算在任何人的每人上限裡。

「第幾順位」是候選清單裡的位置，由 `api` 算給前端看。

## 開始一個下載

1. 把 `state` 改成 `downloading`、`phase = 'metadata'`、`started_at` 和 `last_progress_at` 設成現在、`clean_stop = false`。
2. 確認磁碟真的有空間：`/data` 的可用空間要大於「還沒下載的量 + 系統保留」。不夠就標成失敗（`DISK_FULL`）。
3. `client.add(磁力連結, { path: '/data/torrents/<hash>', bitfield? })`。磁力連結的組法在 [05-yts.md](05-yts.md)。`bitfield` 只在這一列有存、而且 `clean_stop` 在上次是 true 時才給。
4. 掛上事件（見下表）。

### 拿到種子資訊（`metadata`）時

- **路徑檢查**：每個檔案的路徑解析後必須落在 `/data/torrents/<hash>/` 裡面。有任何一個跑到外面，立刻停止這個下載並標成失敗（`UNSAFE_PATH`），記一筆安全性 log。這時還沒有寫入任何資料。
- **大小檢查**：拿 `torrent.length` 和目前計入的大小 `max(size_bytes, length_bytes)` 比。
  - 沒有比較大：寫入 `length_bytes`，繼續。
  - 大了，但多出來的在 64 MB 以內（YTS 列的大小常常沒算進隨片附的小檔案）：寫入 `length_bytes`，繼續，不另外檢查空間。
  - 多出來的超過 64 MB：在交易裡呼叫 `storage_admit(差額)`。通過就寫入 `length_bytes`，繼續；不通過就寫入 `length_bytes`，停止，標成失敗（`SIZE_MISMATCH`）。之後重試時，需求用比較大的那個數字算。
- **有沒有影片**：找出最大的影片檔（`.mp4`、`.mkv`、`.avi`、`.mov`、`.m4v`、`.webm`）。一個都沒有就標成失敗（`NO_VIDEO_FILE`）。

三項檢查都通過：

- 全部檔案都下載（YTS 的種子通常是一個影片檔加幾個很小的附檔），不做挑檔。
- `phase` 改成 `data`。

任何一項沒過，都走下面「失敗時的收尾」：**停止，但不刪除任何東西。** 已經下載的部分留著，這一列留著，由人決定移除或（清出空間後）重試。

### 事件

| 事件 | 做什麼 |
| --- | --- |
| `infoHash` | 沒事（測試時在這之後才能 `addPeer`） |
| `metadata` | 上一節 |
| `download` | 只更新記憶體裡的「最後有進度的時間」，不要每次都寫資料庫 |
| `wire` | `wire.type` 是 `tcpIncoming` 時，記下「最近一次有人連進來」的時間（寫進心跳的 `info`）。`utpIncoming` 不算：uTP 走 UDP，我們自己連出去之後 NAT 會讓對方暫時連得回來，證明不了埠有轉發（階段 0 實測） |
| `noPeers` | 記 debug log。失敗與否由停滯檢查決定 |
| `warning` | 記 warn log，不處理 |
| `error` | 這個下載的致命錯誤。`ENOSPC` 標成 `DISK_FULL`，其他標成 `IO_ERROR`。走「失敗時的收尾」 |
| `done` | 見「完成」 |

### 寫進度

每 2 秒對每個進行中的下載寫一次：`progress`、`downloaded_bytes`、`uploaded_bytes`、`download_bps`、`peers`，有新資料時更新 `last_progress_at`；然後 `NOTIFY paiban_events`（類型 `torrent`）。做種中的下載只更新 `uploaded_bytes`，不用通知。

### 停滯

| 情況 | 門檻 | 結果 |
| --- | --- | --- |
| 一直拿不到種子資訊 | 5 分鐘 | 失敗，`METADATA_TIMEOUT` |
| 有種子資訊但沒有新資料 | 設定 `downloads.stallMinutes`，預設 30 分鐘 | 失敗，`STALLED` |

### 失敗時的收尾

不論是哪一種失敗（停滯、拿不到種子資訊、大小不符、沒有影片檔、路徑不安全、磁碟錯誤），做的事都一樣：

1. 存下 bitfield（已經有種子資訊的話）。
2. `destroy({ destroyStore: false })`：離開用戶端，檔案留在磁碟上。
3. 量出資料夾的實際大小，寫進 `disk_bytes`。
4. `state = 'failed'`、`error_code`、`error_message`（英文，給 log 和管理員）、`clean_stop = true`、速度和節點數歸零。
5. 替每位持有人寫一則 `download.failed` 的通知；`NOTIFY`（`torrent`、`usage`、每則通知各一則 `notification`）。

名額讓給下一個。**失敗不會刪除任何東西**：殘留算進用量的「失敗下載的殘留」，直到有人按移除。

### 重試

重試由 `api` 發起：在交易裡通過 admission 之後，把 `state` 設成 `queued`、`want` 設成 `run`、`queued_at` 設成現在（回到隊伍尾端）、清掉錯誤。輪到它時，`torrent` 用存下來的 bitfield 從已下載的部分接續。

## 手動加入（Brian，2026-10-09；D26）

使用者在「手動加入種子」視窗貼磁力連結或上傳 .torrent 檔（[11-pages.md](11-pages.md)）。

**讀取（`api`）**：

- 磁力連結只取 info hash（`btih`，hex 或 base32）和 tracker。.torrent 檔最大 4 MB，只支援 BitTorrent v1；只留 info 字典，重新編碼成 `{info}` 存起來，確認 info hash 沒變。
- tracker 過濾：只留 `udp`、`http(s)`、`ws(s)`，主機不能是 localhost、私有或保留位址、單一名稱的內部主機，網址裡不能帶帳號密碼；最多 20 個。網頁種子（`ws`、`url-list`）、`x.pe` 之類的欄位一律丟掉，所以 WebTorrent 不會去連使用者寫的任何網址。
- 寫一列 `torrent_inspections`。.torrent 檔直接是 `ready`；磁力連結是 `pending`，`NOTIFY paiban_inspect`。同一個 info hash 已經有存過的 info 字典（網站上已有、或之前讀過）就直接 `ready`，不再問種子群。
- 每人每小時最多讀 30 次（`RATE_LIMITED`）。

**取種子資訊（`torrent`，`Inspector`）**：

- 收到通知或每 2 秒，取最舊的 `pending`（同時最多 3 個），用**記憶體**當儲存、一個 piece 都不選地加進 WebTorrent；拿到 metadata 就離開，把 `{info}` 寫回、`ready`。2 分鐘內沒拿到就 `failed`（`NO_METADATA`）。磁碟上不會寫任何東西。
- 服務重啟時，還在 `pending` 的直接標成 `failed`（不會接著問）。

**加入（`api`，`POST /api/torrents/manual`）**：

- 要先在 TMDB 選一部電影（[04-api.md](04-api.md)）。片名、年份、片長、類型、簡介（中文和英文）、海報、IMDb 編號從 TMDB 來。IMDb 編號和網站上已有的電影（例如 YTS 的那一列）相同就掛在那一列下；否則建一列 `yts_id` 是空的電影，同一個 TMDB 編號只有一列。
- 要下載的檔案是最大的影片檔（`.mp4`、`.mkv`、`.avi`、`.mov`、`.m4v`、`.webm`）；沒有影片檔（`NO_VIDEO_FILE`）或有路徑跑到資料夾外面（`UNSAFE_PATH`）的不能加入。
- 預留的空間：那個檔案的大小加預覽預留。預估能不能直接播：檔名看起來是 x264、8-bit，而且是 `.mp4` 或 `.m4v` 才算能播，其他都先預留預覽檔（[10-storage.md](10-storage.md)）。
- 版本（畫質、來源、編碼、位元深度）從種子名稱和檔名推測，只用來顯示和預估。
- `torrents.origin = 'manual'`，`metainfo` 是 `{info}`，`trackers` 是過濾過的 tracker。用過的 `torrent_inspections` 那一列刪掉（是資料列，不是檔案）。海報從 TMDB 抓一份存在 `/data/posters/tmdb-<id>.<副檔名>`，由 `GET /api/movies/:id/poster` 提供。

**下載**：

- 從存著的 `{info}` 開始（不用再取 metadata），帶它自己的 tracker。
- 一開始不選任何 piece；metadata 一進來（WebTorrent 檢查磁碟上已有的 piece 之前）只選最大的影片檔，和旁邊的字幕檔（`.srt`、`.ass`、`.ssa`、`.vtt`，每個最大 5 MB，最多 50 個；下載完由 `media` 加成字幕，見 [08-media-pipeline.md](08-media-pipeline.md)「種子內附的字幕」）。進度、大小、完成都看這些檔案合起來：WebTorrent 的整個種子永遠不會「完成」，所以等它們每一個的 `done`。預留的空間也是影片加這些字幕檔。
- 和選中的檔案共用頭尾 piece 的相鄰檔案，會寫進那一小段，其他檔案不會出現。`disk_bytes` 照樣量整個資料夾。
- 其他行為（排程、暫停、失敗、做種、移除）和 YTS 的下載一樣。

## 暫停

1. 還沒加進用戶端（`queued`）：直接把 `state` 改成 `paused`。
2. 進行中：存 bitfield → `destroy({ destroyStore: false })` → 回呼裡把 `state` 改成 `paused`、`clean_stop = true`。

暫停的下載繼續佔它的預留空間（介面上寫「暫停中，空間仍然保留」）。

## 完成

`done` 事件觸發時：

1. 依做種設定決定要不要留在用戶端裡（下一節）。
2. 量出 `/data/torrents/<hash>` 的實際大小。
3. 在**一個交易**裡：
   - `state = 'completed'`、`progress = 1`、`disk_bytes`、`completed_at`、`bitfield = null`
   - 建立 `media_files`：主影片檔的相對路徑和大小；`direct_play` 先用 YTS 資料預測的值；`analysis_state` 依**現在**的設定 `media.analyzeAuto` 是 `pending` 或 `none`
   - 預覽的部分照**接受下載時定下來的計畫**搬過來，不重新看設定（D40）：`reserve_bytes = preview_reserve_bytes`；這個值大於 0 時 `audio_state = 'pending'`；`preview_proxy_res` 有值時 `proxy_state = 'pending'`、`proxy_res` 就是它。然後把 `torrents.preview_reserve_bytes` 歸零
   - 替每位持有人寫一則 `download.completed` 的通知。不等分析：這部片已經可以進工作區找字幕了
4. `NOTIFY paiban_media`（叫 `media` 來探測這個檔案、排入分析和預覽資產）和 `NOTIFY paiban_events`（`torrent`、`usage`、每則通知各一則 `notification`）。

`torrent` 不碰工作佇列。它只把列寫成「等待中」，`media` 的對帳步驟會替它排入工作（[02-architecture.md](02-architecture.md)）。

階段 3 還沒有 `media` 程式。那個階段先一律把 `analysis_state` 寫成 `none`，這樣下載完成後狀態直接是「完成」；預覽資產照上面寫成「等待中」，只是還沒有人處理。階段 4 加入 `media` 之後，`analysis_state` 才改成依設定（[14-plan.md](14-plan.md)）。

## 做種

設定 `downloads.seedMode`：

| 值 | 行為 |
| --- | --- |
| `stop`（預設） | 完成就 `destroy({ destroyStore: false })`，不再上傳 |
| `ratio` | 留在用戶端繼續上傳，`seeding = true`；上傳量達到檔案大小（分享率 1.0）時停止並把 `seeding` 改回 false |

下載過程中本來就會同時上傳，這個設定只決定完成之後。做種期間 `uploaded_bytes` 照樣每 2 秒更新，分享率就是用它除以檔案大小算的。

程式重啟時，`seeding = true` 的用 `skipVerify: true` 加回去。

## 移除

`want = 'remove'` 的列，不論目前是什麼狀態：

1. 在用戶端裡就 `client.remove(hash, { destroyStore: true })`。這也是一種刪除：這個呼叫要放在唯一的刪除模組裡（或由它包一層），不要散在別處（[10-storage.md](10-storage.md)）。
2. 依 [03-data-model.md](03-data-model.md) 的「刪除一個下載時發生的事」：刪除所有相關資料夾；在一個交易裡把這部片還沒做完的匯出標成失敗、其他還沒結束的 `tasks` 標成取消、刪掉這一列。不用等 `media`：正在處理這部片的工作會自己停，而且不會留下東西。
3. `NOTIFY`：`torrent.removed`、`usage`，以及被改動的工作、匯出和新寫的通知各自的那一則（清單在 03 的同一節）。

## 即時檢視（下載細節頁）

下載細節頁（[11-pages.md](11-pages.md)）開著時，`api` 每次被問 `GET /api/torrents/:id/live` 就把 `torrent_live.wanted_until` 設成 10 秒後。主迴圈每一輪（2 秒）的最後，對 `wanted_until` 還沒過的下載寫一份快照到 `torrent_live.data`；沒人在看的下載什麼都不寫。`api` 只回 6 秒內寫的快照，否則回 `null`（還沒做好，或下載沒在跑）。

快照（`TorrentLive`）從 WebTorrent 讀（`engine.ts` 的 `snapshot()`，所有內部欄位都在這一個檔案裡包起來）：

- 每個連線：位址（遮成「61.220.x.x」才離開這個服務）、國家、是不是區網、程式名稱（對方 extended handshake 的 `v`，沒有時從 peer id 的「-qB4630-」解出來）、誰連誰、TCP 或 uTP、速度、對方擁有幾成。
- 每一塊：已完成、正在跟某個節點要（`_reservations` 不空）、幾個連線中的節點有（最多 255）。
- 最近兩分鐘的速度：每一輪記一點，只記在記憶體裡，每部片最多 60 點。

國家用 DB-IP 的免費「IP to Country Lite」（CC BY 4.0），建置映像檔時下載到 `/opt/geo`（`GEOIP_CSV`），查詢不連外。載入在啟動時背景進行（這台機器上約 7 秒、約 100 MB 記憶體），載入前節點沒有國家。IPv6 只比對前 64 位元：沒有國家分配到比 /64 更小的範圍。伺服器自己的位置（Brian，2026-10-06：自動偵測）不去問任何外部服務：節點在 extended handshake 裡會說它看到我們的公開位址（BEP 10 的 `yourip`；qBittorrent、Deluge、Transmission 會送，WebTorrent 不會）。每個節點的回報算一票，用同一張 DB-IP 表查國家，票最多的國家就是伺服器所在地（`live.ts` 的 `HomeFinder`）；同一個節點每輪都在，也只算一票；平手時維持目前的國家，地圖不會來回跳；區網和查不到國家的位址不算。只記在記憶體裡，最多記 200 個節點的回報。還沒有任何節點回報之前（剛啟動、或只連到 WebTorrent），由 `TZ` 對應國家（`live.ts` 的表，不認得的時區當作台灣）。只在有人開著下載細節頁時讀快照，所以也只在那時收票。`TorrentLive.homeFrom` 說是哪一種（`peers` 或 `timezone`）。

## 重啟

啟動時：

| 資料庫裡的狀態 | 做什麼 |
| --- | --- |
| `downloading`，`clean_stop = true`，有 bitfield | 用 bitfield 加回去（快速接續） |
| `downloading`，其他情況 | 不給 bitfield 加回去。WebTorrent 會把磁碟上的資料全部重新驗證一次（`phase = 'verifying'`），慢但一定正確 |
| `completed` 且 `seeding = true` | `skipVerify: true` 加回去 |
| `want = 'remove'` | 繼續移除 |
| 其他 | 不動，等主迴圈 |

收到 SIGTERM：停止排程 → 對每個進行中的下載存 bitfield、`destroy({ destroyStore: false })`、`clean_stop = true`（`state` 維持 `downloading`，這樣下次啟動會接續）→ `client.destroy()` → 結束。全部要在 25 秒內完成。

`clean_stop` 的用意：bitfield 只有在「存完之後就沒有再寫過磁碟」時才可信。程式被強制終止或斷電時，寧可花時間重新驗證，也不要相信一份可能和磁碟對不上的 bitfield。

## 連入狀況

這個程式沒有辦法從外面測自己（那需要第三方服務）。改用觀察：只要有任何 `tcpIncoming` 的連線進來過，就表示埠是通的（`utpIncoming` 不算，理由見上）。把「最近一次連入的時間」寫在 `service_heartbeats.info`，管理頁顯示成：

- 「最近 24 小時內有外部連入」：正常。
- 「還沒觀察到外部連入」：可能埠沒開。說明要在 Docker 和路由器上開 `TORRENT_PORT`（TCP、UDP）和 `TORRENT_DHT_PORT`（UDP）。沒開仍然能下載，只是比較慢。

## 界線

- 這個程式只處理資料庫裡已經存在的 info hash，和 `torrent_inspections` 裡等著取種子資訊的磁力連結。種子只從 `api` 的兩個入口進來（D26）。
- 它不需要也拿不到 `SECRET_KEY`。
- 它不刪除 `want` 不是 `remove` 的任何東西。失敗的下載留著殘留，直到有人按移除。
- `want` 只有 `api` 會寫，而且每一次寫成 `remove` 都對應到某個人按下的動作（最後一位持有人移除，或管理員強制刪除）。

## 測試

- **單元**：排程規則（全站上限、每人上限、跳過與不跳過）、停滯判斷、路徑檢查。把 WebTorrent 用一個假的物件換掉。
- **整合**：照 `reference/torrent/local-swarm-test.mjs` 的做法，在測試裡起一個做種的用戶端，讓 `torrent` 程式下載 `fixtures/clip.mp4`。要涵蓋：下載完成並建立 `media_files`、暫停再繼續、強制終止程式後重啟接續、移除後資料夾消失、種子比列出的大而空間不夠時失敗（而且已下載的部分還在、用量算的是殘留）、失敗後重試從已下載的部分接續。
- 測試裡關掉 DHT、tracker、LSD，只用 `addPeer('127.0.0.1:<埠>')`。為此程式有一個只在開發和測試時啟用的掛鉤：環境變數 `TORRENT_TEST_PEERS`。`NODE_ENV=production` 時設了它，程式拒絕啟動（[02-architecture.md](02-architecture.md)）。
