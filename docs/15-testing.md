# 15 測試

## 三條不能破的線

1. **自動化測試不連外部網路。** 不連 YTS、不連任何字幕來源、不連 TMDB、不連公開的 BitTorrent 網路。CI 在沒有網路的環境也要全部通過。
2. **測試和開發不使用有版權的影片，自動化測試也不使用從真實來源下載的字幕。** 只用 `fixtures/` 的合成素材；需要真實電影時用 Blender 基金會的開放電影（階段 0）。
3. **測試不需要真的金鑰。** 需要金鑰的程式路徑用假的值加上錄下來的回應來測。

對真實來源的確認是**手動**做的（階段 0、5），結果寫進報告。錄下來的回應（JSON、HTML）把金鑰的值換成 `PLACEHOLDER` 之後變成測試素材。確認時下載的字幕壓縮檔只是拿來看格式：每個來源一兩個，放在 `.scratch/`，看完就刪，不進 repo（D29）。

## 分層

| 層 | 工具 | 測什麼 | 跑多快 |
| --- | --- | --- | --- |
| 單元 | Vitest | 純邏輯：對齊核心、字幕的編碼與解析、各來源的回應解析、預留量的計算、檔名和網址的驗證、排程規則、權限函式 | 幾秒 |
| 資料庫 | Vitest + 真的 PostgreSQL（compose 起一個測試用的）。PGlite 可以拿來跑不需要並行的案例，但它只有一條連線，測不到「兩個連線同時」 | 遷移、遷移和 `db/schema.sql` 等價、`storage_usage`、`storage_admit`、`provider_take_slot`、交易與並行、外鍵的連帶行為 | 幾秒到十幾秒 |
| 服務整合 | Vitest，把三個程式在同一個測試裡啟動，共用一個暫存的 `/data` | 下載到分析到匯出的工作流程；重啟；取消 | 一兩分鐘 |
| 端對端 | Playwright，對著 `docker compose` 起來的整個系統 | 使用者看得到的行為 | 幾分鐘 |

每一層都不該依賴上一層已經測過的細節。例如端對端測試不需要再驗證 Big5 轉碼的每個邊角，那是單元測試的事。

## 離線的完整流程

整條主流程（搜尋 → 下載 → 分析 → 找字幕 → 同步 → 匯出 → 下載 MKV）要能在沒有網路的情況下跑完。需要三個替身，都只在測試和開發的 compose 設定裡出現：

**假的 YTS**：一個很小的 HTTP 服務，提供 `list_movies.json` 和 `movie_details.json`，回應形狀和真的相同（[05-yts.md](05-yts.md)）。片單用原型的 14 部老片。其中一部的三個版本，info hash 指向下面本機做種的三個檔案。

**本機做種**：一個 WebTorrent 用戶端做種三個檔案，當作同一部片的三個版本，關掉 DHT、tracker、LSD：

| 檔案 | 假 YTS 把它標成 | 用途 |
| --- | --- | --- |
| `fixtures/clip.webm` | 720p x264 8-bit | 端對端測試的主角：瀏覽器真的播得出來（見下面的注意事項），而且算「能直接播」 |
| `fixtures/clip.mp4` | 1080p x264 8-bit | 服務整合測試（不經過瀏覽器的）：分析結果要和 `fixtures/data.json` 完全相同 |
| `fixtures/clip.hevc10.mp4` | 2160p x265 10-bit | 「不能直接播」的版本：聲音檔、預覽檔、預留 |

`torrent` 程式用測試專用的掛鉤（環境變數 `TORRENT_TEST_PEERS=seed:51801`）在加入種子後直接 `addPeer`。做法照 `reference/torrent/local-swarm-test.mjs`。種子的 info hash 取決於檔案內容和分塊大小，所以由做種的服務在啟動時算出來，寫到假 YTS 讀得到的地方。

**假的字幕來源**：一個 HTTP 服務，依路徑回傳錄下來的回應和 `fixtures/archive.zip`。

**怎麼把正式的程式指到這些替身**：正式的程式只連 `https://`、不連內部位址、只連白名單裡的主機，替身全部會被擋掉。所以有三個只給開發和測試用的環境變數（[02-architecture.md](02-architecture.md)、[12-auth.md](12-auth.md)）：

```yaml
# 只出現在開發和測試的 compose 檔。正式的 compose 檔裡沒有這幾行。
environment:
  NODE_ENV: test                      # 或 development。是 production 的話,下面任何一個有值就拒絕啟動
  ALLOW_LOCAL_SOURCES: "1"            # api、media:允許 http:// 和內部位址
  SOURCE_OVERRIDES: >-                # api、media:固定的來源主機 → 替身
    {"www.justsubtitles.com": "http://fake-sources:8090/justsubtitles",
     "search.justsubtitles.com": "http://fake-sources:8090/justsubtitles-search",
     "dl.subdl.com": "http://fake-sources:8090/subdl-dl",
     "api.subdl.com": "http://fake-sources:8090/subdl",
     "api.themoviedb.org": "http://fake-sources:8090/tmdb",
     "yts-subs.com": "http://fake-sources:8090/yify",
     "subtitles.yts-subs.com": "http://fake-sources:8090/yify-dl",
     "api.assrt.net": "http://fake-sources:8090/assrt"}
  TORRENT_TEST_PEERS: "seed:51801"    # torrent
```

- `SOURCE_OVERRIDES` 的替換發生在共用的對外用戶端裡，而且在主機白名單檢查**之後**：程式照常組出 `https://www.justsubtitles.com/api/subtitles/27205?lang=EN`，白名單照常檢查，最後一步才把主機那一段換成替身的網址。所以白名單和各來源組網址的程式都還是被測到。
- YTS 的網址本來就是設定值，測試的第一步用管理員的身分把它設成 `http://fake-yts:8080`；`ALLOW_LOCAL_SOURCES` 讓這個值通過驗證。
- 這三個變數的值是伺服器之間的位址，不是金鑰。

有了這三個，端對端測試的劇本就是：

1. 管理員登入，設定 YTS 網址（假的）和容量上限。
2. 搜尋，進電影頁，下載 `clip.webm` 對應的那個版本。
3. 等到片庫裡出現、分析完成。
4. 進工作區，搜尋字幕（假的來源回傳幾條候選，其中一條其實是 `late.zh-TW` 的 Big5 版）。
5. 排名，加入建議的那一條。
6. 進同步，自動對齊，把檢查點都標成準，確認。
7. 匯出，等完成，下載 MKV。
8. 用 ffprobe 檢查下載回來的檔案：一條影像、一條聲音、一條字幕；把字幕抽出來，和 `truth.zh-TW.srt` 比，每句開始時間的差在 0.1 秒內（扣掉封裝時共同的位移）。

這一個測試通過，就表示每一段都接得起來。

## 瀏覽器測試的注意事項

- **Playwright 內建的 Chromium 不能解碼 H.264。** 需要真的播放的測試，做種的檔案用 `fixtures/clip.webm`。「能不能直接播」的規則把 WebM（VP9 加 Opus）算成能直接播，就是為了讓這條路不依賴環境（[08-media-pipeline.md](08-media-pipeline.md)）。另一個做法是用安裝在系統上的 Chrome（`channel: 'chrome'`），但那要求每台跑測試的機器都裝了 Chrome。
- **用 WebM 時分數可能差 1 個百分點。** WebM 的聲音重新編碼過，人聲偵測的結果和 `clip.mp4` 有極小的差異（9,242 個影格裡 28 個不同）。位移和速率不受影響。用 WebM 的測試比對分數時容許正負 1 個百分點；要比對到完全相等的（分析結果對 `data.json`）用 `clip.mp4`，放在不經過瀏覽器的測試裡。
- 需要讓影片自動播放：啟動瀏覽器時加 `--autoplay-policy=no-user-gesture-required`。
- 不要用固定的 `waitForTimeout` 等非同步的結果；等畫面上的狀態（分數變了、狀態標籤變了）。原型的 `e2e.cjs` 裡有固定等待，那是原型，不要照抄。
- 每個測試結束時檢查 console 沒有錯誤。
- 版面檢查：1280 px 和 400 px 各跑主要頁面，確認 `document.documentElement.scrollWidth <= window.innerWidth`；淺色和深色各截一張圖。

## 從原型和參考程式帶過來的測試

這些是現成的，搬進專案、改成專案的測試工具即可：

| 來源 | 內容 | 搬到哪裡 |
| --- | --- | --- |
| `reference/sync-core/core.test.ts` | 對齊核心，17 項 | `packages/shared`（階段 1 搬過去，從 `node:test` 改成 Vitest） |
| `reference/subtitles/text.test.mjs` | 編碼、語言、繁簡、ASS，5 項 | `apps/server` 的字幕模組 |
| `db/schema.test.mjs` | 用量、admission、預覽計畫、請求排隊、約束，11 項 | `apps/server` 的資料庫測試，改成對 Drizzle 遷移出來的 schema |
| `reference/torrent/local-swarm-test.mjs` | WebTorrent 的行為 | `torrent` 的整合測試 |
| `prototype/workbench/e2e.cjs` | 工作台，40 項 | Playwright；見 [09-sync-workbench.md](09-sync-workbench.md) 的「驗收」 |
| `prototype/platform/e2e.cjs` | 每一頁的主要流程，72 項 | Playwright；劇本要改成對著真的後端 |

## 一定要有的測試

各文件裡的「驗收」和「要測的情況」都要變成測試。下面把最容易被漏掉、而且出錯代價最高的集中列一次。

**不自動刪除**
- 掃描原始碼：只有指定的模組呼叫刪除 `/data` 底下檔案的函式。
- 掃描原始碼：**沒有任何刪除是由「時間到了」或「東西舊了」決定的。** 刪除模組的函式不接受、也不計算任何「多久以前」的條件；呼叫它們的地方不比較時間戳。定時跑的迴圈本身不在禁止之列：`torrent` 每 2 秒看一次有沒有 `want = 'remove'` 的列、工作每 2 秒檢查自己該不該停，執行的都是某個人已經按下去的刪除或取消（[10-storage.md](10-storage.md) 的「哪些清理不算自動刪除」）。
- 把上限調到低於用量：磁碟上的檔案數量和大小前後相同。
- 三個程式各重啟一次：`/data` 底下除了 `tmp/` 和 `*.part`，沒有任何東西消失。

**容量**
- [10-storage.md](10-storage.md) 的「要測的情況」。

**金鑰與外部請求**
- JustSubtitles 回應裡帶 `api_key` 的網址：解析後沒有 query string；資料庫裡沒有；log 裡沒有。
- 用假的金鑰跑每個來源一次，在全部的 log 輸出裡搜尋那個字串：找不到。
- 對白名單以外的主機、對內部位址的請求被擋下，包含經過轉址之後的。
- 字幕庫：整個測試過程中，對它的主機沒有任何請求。

**權限**
- 走過所有路由：沒登入一律 401（公開的幾個除外）；成員對管理路由一律 403；不是持有人對那部片的任何端點一律 403，**呼叫的人是管理員也一樣**。這個測試從路由表自動產生，新增路由時不需要記得補。

**測試用的開關不會跑到正式環境**
- `NODE_ENV=production` 時設了 `ALLOW_LOCAL_SOURCES`、`SOURCE_OVERRIDES` 或 `TORRENT_TEST_PEERS`：程式報錯結束，不是默默忽略。
- 沒有設 `ALLOW_LOCAL_SOURCES` 時：`http://` 和內部位址的 YTS 網址存不進去，對外用戶端也不連。

**工作不會做兩次，也不會掉**
- 同一列被排入兩次：只做一次。
- `media` 在轉檔途中被強制終止再啟動：那個工作從頭再做，沒有殘留的 `.part`，預留量沒有算兩次。
- `api` 在字幕查詢途中被重啟：沒有來源永遠停在「查詢中」。
- 正在轉檔的片被刪除：ffmpeg 停下來，刪除完成之後 `/data` 底下沒有那部片的任何東西，也沒有新冒出來的孤兒。

**只接受 YTS 的 hash**
- `POST /api/torrents` 帶一個不在那部片版本清單裡的 hash：被拒絕，資料庫裡沒有新增任何東西。
- 請求裡多帶 `sizeBytes`、`magnet` 之類的欄位：被忽略或拒絕，實際用的是伺服器查到的值。

**同步文件**
- 套用文件的函式對同一份輸入永遠得到同樣的輸出；不修改輸入。
- 伺服器匯出時算的時間，和瀏覽器顯示的時間，來自同一個函式（`applyDoc`）。

## 指令

專案建立後，把實際的指令寫進 `AGENTS.md` 的「指令」一節。至少要有：

```
pnpm install
pnpm typecheck
pnpm lint
pnpm test              # 單元 + 資料庫 + 服務整合
pnpm test:e2e          # 會先用測試設定把 compose 起起來
pnpm dev               # 本機開發:假的 YTS、本機做種、假的字幕來源一起起來
```

`pnpm dev` 起來之後，不需要任何金鑰和網路就能走完整個流程，這是開發時最常用的狀態。
