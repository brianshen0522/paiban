# 規格變更紀錄

實作和原本的規格不一樣的地方。每改一處就記一則，並且把受影響的文件一起改掉：這裡是「改了什麼、為什麼」的紀錄，文件本身永遠要是最新的。最新的寫在最上面。

每一則的格式：

```text
## 2026-10-12 射手網回應的語言欄位

- 原本：docs/07-subtitle-providers.md 寫 lang.langlist 的鍵是 langcht、langchs……
- 改成：……
- 原因：階段 0 錄到的真實回應是……
- 改了哪些檔案：docs/07-subtitle-providers.md、reference/providers/assrt.search.sample.json
- Brian 是否已確認：是 / 否 / 不需要
```

---

## 2026-10-06 防跨站檢查也接受「送到哪個主機就從哪個主機來」的請求

- 原本：`docs/12-auth.md`、`docs/04-api.md` 要求寫入請求的 `Origin` 和 `PUBLIC_URL` 同源。
- 改成：`Origin` 等於 `PUBLIC_URL`，或者 `Origin` 的主機就是這個請求的 `Host`，都接受。邀請和重設連結的開頭仍然用 `PUBLIC_URL`；但 `PUBLIC_URL` 還是 `localhost` 時，改用管理員當下打開網站的位址。
- 原因：`PUBLIC_URL` 沒改到實際網址時，從別台電腦用 IP 打開網站連登入都會被拒（Brian 要在早上從別的裝置測試）。跨站請求帶的是攻擊者網站自己的 Origin，和 Host 不同，所以防護不變；`X-Requested-With` 的檢查也照舊。
- 改了哪些檔案：docs/12-auth.md、docs/04-api.md
- Brian 是否已確認：否

## 2026-10-06 匯出：驗證的細節、移除電影時的 tracks/、取消到一半被重啟

- 原本：
  - docs/04-api.md 只寫了 `NO_CONFIRMED_SUBTITLE`、`INVALID_FILENAME` 兩種錯誤，沒說「預設軌不是恰好一條」、「同一條選兩次」、「選了別部片的字幕」、「下載還沒完成」怎麼回，也沒說檔名錯誤要怎麼區分兩句說明。
  - docs/03-data-model.md 寫「排隊中的匯出的 `tracks/` 由 `torrent` 刪；進行中的由封裝工作自己收」。
  - 「做完之後檢查一次」沒說檢查的是 `.part` 還是改名之後的檔案。
  - 沒寫 `media` 在取消到一半被重啟時怎麼辦。
- 改成：
  - 預設軌不是恰好一條、同一條選兩次：`VALIDATION`（`details.fields.tracks` 是 `ONE_DEFAULT`、`DUPLICATE`）。別部片的字幕：`NO_CONFIRMED_SUBTITLE`。下載沒完成：`MEDIA_NOT_READY`。檔名：`INVALID_FILENAME`，`details.fields.fileName` 是 `EXTENSION`、`CHARACTERS`、`TOO_LONG`，對應頁面上的兩句說明；另外拒絕控制字元、開頭是點、頭尾空白（檔名會進 HTTP 標頭和別人的磁碟）。
  - `torrent` 移除電影時，替**所有**它標成失敗的匯出刪 `tracks/`（排隊中和進行中都刪）；進行中的封裝工作之後再刪一次也不算錯。這樣 `media` 剛好沒在跑時也不會留下沒有人收的資料夾。
  - 檢查的是 `.part`，通過才改名，維持「看得到正式檔名的檔案一定是完整的」。
  - `media` 啟動時，`cancel_requested` 已經是 true 的匯出直接收掉（刪 `tracks/`、刪那一列、`tasks` 標 `cancelled`）；對帳第 4 項也收掉對象已經不在 `queued`/`running` 的 `export` 工作。
  - 已經要求取消、正在等 `media` 停下來的匯出，清單不列出，再刪一次回 `NOT_FOUND`。
  - 管理員強制刪除排隊中的匯出時，它的 `tasks` 也標成 `cancelled`，並發 `export.removed`。
  - 匯出需要的空間只寫在 `packages/shared` 的 `exportNeedBytes()`，`Workspace.exportNeedBytes` 和 admission 用同一個。
- 原因：實作階段 7 時發現的缺漏；行為依 docs/08 的共通規矩推出來，沒有改變任何既定的決定。
- 改了哪些檔案：docs/03-data-model.md、docs/04-api.md、docs/08-media-pipeline.md、docs/10-storage.md、docs/11-pages.md、AGENTS.md（指令）
- Brian 是否已確認：否（交接層級）

## 2026-10-06 media 服務：不用 pg-boss，錯誤每種資產一格，測試在映像檔裡跑

- 原本：`docs/02-architecture.md` 用 pg-boss 當工作佇列；`media_files.error` 和 `MediaStatus.error` 只有一格。
- 改成：
  - `media` 直接從資料表認領工作：等待中的列就是待辦，帶條件的更新認領，所以重複排入只會做一次；重啟時把「進行中」改回「等待中」再對帳。三種工作（分析、預覽資產、重新計算用量）各自同時只跑一個。
  - `media_files.error` 存 `{analysis?, audio?, proxy?}`，合約改成 `MediaStatus.errors`。之後預覽檔失敗不會蓋掉「為什麼沒有波形」。
  - 需要 ffmpeg 和 ffsubsync 的測試（`apps/server/test/media.test.ts`）在主機上沒有這些工具時明確略過，`pnpm test:image` 在映像檔裡實際跑。
- 原因：規格本來就以資料表為準，佇列只是「叫人去做事」；少一套東西，去重和重啟的行為也更容易驗證。錯誤一格是交叉比對時發現的規格缺陷。
- 改了哪些檔案：docs/02-architecture.md、docs/03-data-model.md、docs/04-api.md、docs/08-media-pipeline.md、docs/09-sync-workbench.md、docs/11-pages.md、packages/shared/src/contracts/api.ts、db/schema.sql（註解）
- Brian 是否已確認：否（交接層級）

## 2026-10-06 總覽的 DISK_LOW 門檻、media 服務的心跳

- 原本：`docs/11-pages.md` 有 `DISK_LOW` 這個問題，但 10 和 13 都沒有定門檻；`media` 服務在它的階段之前不寫心跳。
- 改成：磁碟本身的可用空間少於系統保留的兩倍（預設 4 GB）就列為問題。`media` 服務現在就寫心跳（它還沒有工作可做），否則總覽會一直說它沒有回應。系統狀態頁還沒做，所以總覽裡指向它的問題（`SERVICE_DOWN`、`FAILED_TASK`）先不顯示按鈕。
- 原因：做總覽時需要；門檻選系統保留的兩倍，是因為少於一倍時 admission 已經會拒絕，兩倍時還來得及處理。
- 改了哪些檔案：docs/11-pages.md、docs/13-settings.md
- Brian 是否已確認：否（交接層級的細節）

## 2026-10-06 階段的順序：先做登入、搜尋與下載

- 原本：`docs/14-plan.md` 依序做階段 1（帳號與外框）→ 2（搜尋與電影頁）→ 3（下載與容量上限）。
- 改成：Brian 在 2026-10-06 說先做 YTS 搜尋和種子下載，並且要有登入。所以這一輪做了階段 1 的登入、外框和共用程式碼，階段 2 的全部，階段 3 的大部分。還沒做的列在 `docs/reports/phase-1-3.md`（邀請、註冊、重設密碼、個人設定、使用者管理、操作紀錄頁、強制刪除、`media` 程式等）。
- 原因：Brian 的指示（AGENTS.md 依據的優先順序第 1 項）。
- 改了哪些檔案：沒有改計畫本身；這一則是紀錄
- Brian 是否已確認：是（他提出的）

## 2026-10-06 外觀可以選淺色、深色、跟隨系統

- 原本：`docs/17-ui.md` 只跟隨系統，`data-theme` 只給測試用。
- 改成：帳號選單、個人設定和登入頁有三選一，選擇存在裝置的 localStorage；`public/theme-init.js` 在第一次繪製前套用。
- 原因：Brian 的 UI 原則（2026-10-06）：一定要 RWD，一定要能選 Light、Dark、System。
- 改了哪些檔案：docs/17-ui.md、docs/11-pages.md（外框、登入、個人設定）
- Brian 是否已確認：是（他提出的）

## 2026-10-06 資料庫：純 SQL 遷移，不用 Drizzle

- 原本：`docs/02-architecture.md` 選 Drizzle ORM，`docs/14-plan.md` 階段 1 要用 Drizzle 定義 schema 並產生遷移，再寫測試確認和 `db/schema.sql` 等價。
- 改成：遷移是純 SQL 檔，第一個（`apps/server/migrations/0001_init.sql`）就是交接的 `db/schema.sql`。查詢用 `pg` 加手寫 SQL，包在每個領域自己的函式裡。等價測試照做（`apps/server/test/schema-equivalence.test.ts`：兩邊各建一個資料庫，比對欄位、約束、索引、函式和 view）。
- 原因：schema 已經有一份寫好、測過的 SQL；再用 Drizzle 重寫一份，要維持兩份一致，而用量計算、admission、排隊這些本來就要直接寫 SQL。02 的技術選型不在 00 的決定裡。
- 改了哪些檔案：docs/02-architecture.md
- Brian 是否已確認：否（交接層級的技術選擇，報告裡說明）

## 2026-10-06 連入狀況只看 TCP 的連入

- 原本：`docs/06-torrent-worker.md` 把 `tcpIncoming` 和 `utpIncoming` 都當成「埠是通的」。
- 改成：只看 `tcpIncoming`。
- 原因：階段 0 在沒有確認路由器轉發的情況下也看到了 `utpIncoming`（UDP 經由 NAT 回連），會讓管理員誤以為埠開好了。D32 是「交接」層級。
- 改了哪些檔案：docs/06-torrent-worker.md
- Brian 是否已確認：不需要

## 2026-10-06 合約和對齊核心搬進 packages/shared

- 原本：`contracts/api.ts`、`reference/sync-core/core.ts` 和它的測試在交接包的位置。
- 改成：`packages/shared/src/contracts/api.ts`、`packages/shared/src/sync-core/`（`git mv`，只留一份）。測試從 `node:test` 改成 Vitest：只換了 `test` 的來源和 fixtures 的相對路徑，案例和預期值不動（`node:assert` 照用）。
- 原因：`docs/14-plan.md` 階段 1 的第一步。Brian 在 2026-10-06 要求先做登入、YTS 搜尋和下載，這些都要用到合約的型別，所以提前做。
- 改了哪些檔案：全 repo 提到舊路徑的地方（AGENTS.md、README.md、docs/、fixtures/README.md、prototype/README.md、reference/、db/schema.sql 的註解、scripts/phase0/）。`docs/14-plan.md` 描述這次搬移的段落和 `docs/reports/phase-0.md` 是紀錄，保留原本的路徑
- Brian 是否已確認：不需要

## 2026-10-05 Playwright 的 Chromium 能不能解 H.264

- 原本：docs/15-testing.md、08、09、fixtures/README.md、prototype/README.md 寫「Playwright 內建的 Chromium 不能解碼 H.264」。
- 改成：交接時的版本不能；Playwright 1.63（Chromium 153）實測可以。測試仍然用 WebM，理由改成「不依賴這件事」。
- 原因：階段 0 第 7 項實測：H.264 High + AAC 的 MP4（立體聲與 5.1、`moov` 在檔尾）能播、能拖動，畫面確實有解碼。
- 改了哪些檔案：docs/08-media-pipeline.md、docs/09-sync-workbench.md、docs/15-testing.md、fixtures/README.md、prototype/README.md
- Brian 是否已確認：不需要

## 2026-10-05 預設的 tracker 清單

- 原本：docs/05-yts.md 列了四個憑記憶寫的 tracker。
- 改成：只留 `tracker.opentrackr.org:1337` 和 `open.demonii.com:1337`。
- 原因：階段 0 第 5 項實測：`tracker.openbittorrent.com` 查不到網域，`p4p.arenabg.com:1337` 逾時。拿到 YTS 網址後再和 YTS API 文件列的清單對一次。
- 改了哪些檔案：docs/05-yts.md
- Brian 是否已確認：不需要

## 2026-10-05 JustSubtitles：不存在的編號回 200、片名搜尋的形狀

- 原本：docs/07-subtitle-providers.md 寫不存在的編號回 HTTP 500；片名搜尋的外層欄位「沒有記下來」。
- 改成：不存在的編號回 200 或 500 都一樣處理（看內容的 `status: false`，不看狀態碼）；片名搜尋是 `{results: [...]}`，每一筆是 TMDB 搜尋電影的形狀，只有電影。
- 原因：階段 0 第 4 項從伺服器端實際呼叫的結果。另外確認 `ZH`、`ZH_BG` 的每一筆 `url` 都帶別人的 `api_key`，去掉之後下載照樣成功。
- 改了哪些檔案：docs/07-subtitle-providers.md、reference/providers/（換成錄下來的真實回應）
- Brian 是否已確認：不需要

## 2026-10-05 壓縮檔的測試素材

- 原本：fixtures/README.md 寫「`.rar`、`.7z` 和惡意的壓縮檔還沒有，階段 0 自己準備」。
- 改成：`fixtures/archives/` 有 RAR5、7z，以及七種該被拒絕的壓縮檔（路徑跳出、絕對路徑、符號連結、炸彈、超過 200 項、沒有字幕、壞掉的檔案），由 `scripts/phase0/make-archives.sh` 產生。
- 原因：階段 0 第 3 項。RAR4 沒有樣本：目前的 `rar` 7 已經不能寫 RAR4。
- 改了哪些檔案：fixtures/README.md、fixtures/archives/
- Brian 是否已確認：不需要

## 2026-10-05 deploy 的範例檔變成正式檔案

- 原本：`deploy/Dockerfile.example`、`docker-compose.example.yml`、`Caddyfile.example`，沒有建置過。
- 改成：`deploy/Dockerfile`、`docker-compose.yml`、`Caddyfile`。實際建置後改的地方：
  - 三個伺服器服務共用一個映像檔標籤 `paiban-server`，compose 只建一次（原本會建三個內容相同、ID 不同的映像檔）。
  - `pnpm deploy` 要加 `--legacy`（pnpm 12 在沒有開 inject-workspace-packages 時的要求）；建置階段多複製 `tsconfig.base.json`。
  - `apps/server` 只把 `dist/` 放進映像檔。
  - `.env.example` 註明要先建立 `DATA_PATH`：不存在時 Docker 會用 root 建立，而三個服務以 `PUID` 執行，寫不進去（實際遇到）。
  - 頁面的 `<title>` 在建置時從 `SITE_NAME` 帶入（D9）。
- 原因：階段 0 第 1 項。
- 改了哪些檔案：deploy/、docs/12-auth.md（檔名）、docs/02-architecture.md（ffmpeg 版本）
- Brian 是否已確認：不需要
