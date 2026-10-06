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

## 2026-10-06 搜尋框用 TMDB 建議電影（中文片名也找得到）

- 原本：搜尋只問 YTS，YTS 只認得英文片名，用中文譯名找不到片。
- 改成：打字時列出 TMDB 的電影建議；點了用 IMDb 編號找 YTS 上的同一部片並打開。新端點 `GET /api/tmdb/suggest`、`GET /api/tmdb/:tmdbId/yts`、`GET /api/tmdb/poster/:file`，合約多 `TmdbSuggestion`。
- 原因：Brian 在對話裡要求。
- 改了哪些檔案：packages/shared/src/contracts/api.ts、docs/04-api.md、docs/05-yts.md、docs/11-pages.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 節點地圖：自動偵測伺服器所在國家並置中

- 原本：伺服器的位置由 `TZ` 推得（不認得的當作台灣），地圖固定以本初子午線為中心。
- 改成：依節點在 extended handshake 回報的公開位址（BEP 10 `yourip`）投票決定國家，沒有回報時才用 `TZ`；地圖左右轉到那個國家在正中間。合約 `TorrentLive` 多 `homeFrom`。不向任何外部服務查詢自己的 IP。
- 原因：Brian 在對話裡要求系統自動偵測伺服器所在的國家，並把它移到地圖中間。
- 改了哪些檔案：packages/shared/src/contracts/api.ts、docs/06-torrent-worker.md、docs/11-pages.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 同步工作台的工具移到影片下面

- 原本：影片和字幕清單在上，時間軸在中，訊息列和五組工具在最下面；聽檢查點要上下來回捲。工作區頁首有大海報、選字幕的卡片三行。
- 改成：影片下面依序是播放列、訊息列、工具分頁（一次一組，聽檢查點時自動換到「檢查點」）；字幕清單在右邊、和左欄等高；時間軸在下面整個寬度。影片高度隨視窗限制。頁首的海報變縮圖，選字幕的卡片變一列，步驟提示和「確認同步」在同一列。見 docs/09-sync-workbench.md 的「版面」。
- 原因：Brian 在對話裡說選檢查點要往下滑、再往上滑看影片，並要求多找可以優化的地方。
- 改了哪些檔案：docs/09-sync-workbench.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 來源設定改成分頁

- 原本：來源設定是一長頁，九張卡片由上往下排。
- 改成：「電影資料」「字幕來源」「自動對齊」三個橫向分頁，標籤下面一行小字說那一頁的狀況；寬螢幕卡片兩欄。見 docs/11-pages.md 的「來源設定」。
- 原因：Brian 在對話裡說整頁太長，想做成橫向分頁。
- 改了哪些檔案：docs/11-pages.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 確認框改成對話框

- 原本：破壞性的動作按下去後，在同一個位置展開紅色的確認區塊（規格明說不用 modal）。
- 改成：畫面中央的小對話框（`<dialog>`），背景變暗；焦點從「先不要」開始，Esc 或點外面取消，關掉後焦點回到原本的按鈕。七個頁面共用同一個元件，一起換。
- 原因：Brian 在對話裡說「刪除整部片」按下去後，紅色區塊讓那張電影卡片變長，「是個很糟糕的設計」。
- 改了哪些檔案：docs/11-pages.md、docs/17-ui.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 介面的元件與配色整理

- 原本：中文標題在沒有 PingFang、JhengHei 的系統上沒有粗體；狀態標籤和流程標籤只有框線；按鈕、輸入框高度不一；說明框整圈粗框；下載頁兩張卡片黏在一起；手機的頂端列佔三列；工作台字幕清單的文字被置中。
- 改成：打包 Noto Sans TC 當中文的後備字型（按字元範圍切片）；標籤改成淡色底；按鈕和輸入框統一 34 px，強調按鈕改成淡琥珀底；說明框淡框加左側色條；卡片加極淡陰影；表格列懸停；返回連結改成灰色小字；手機頂端列兩列；淺色主題的 `--ink-3` 調深到在頁面底色上也有 4.5:1。見 docs/17-ui.md。
- 原因：Brian 在對話裡要求（「把整個平台的物件設計與配色弄好……很多地方很醜」）。
- 改了哪些檔案：docs/17-ui.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 刪除整部片連匯出檔一起刪；匯出中停用匯出按鈕

- 原本：最後一位持有人從片庫移除電影時，影片、預覽檔、字幕刪除，匯出的 MKV 保留（它們比電影活得久）；管理員強制刪除影片也一樣。同一部片可以連續按「開始匯出」。
- 改成：自己是最後一位持有人時，片庫的按鈕是「刪除整部片」，連同這部片的所有匯出檔一起刪（排隊、完成、失敗的直接刪，封裝中的取消後刪）；別人建立的匯出檔，建立者收到 `item.deleted`。還有別人持有時仍然只是退出。管理員強制刪除影片也連匯出檔一起刪。確認文字列出會刪的匯出檔和合計釋放的空間：合約的 `LibraryItem` 和 `StorageItem` 多 `filmExports {count, bytes}`。這部片有排隊或封裝中的匯出時，「開始匯出」停用。
- 原因：Brian 在對話裡要求（「要有機制可以從片庫那邊刪除整個影片，刪除的時候要把種子、片庫所有字幕和匯出檔一起刪除」「匯出進行中要把匯出按鈕 disable」）。範圍（只有自己持有才刪、管理員可以強制；取代原本的移除）是他在選項裡選的。
- 改了哪些檔案：packages/shared/src/contracts/api.ts、db/schema.sql（註解）、docs/03-data-model.md、docs/04-api.md、docs/10-storage.md、docs/11-pages.md、docs/17-ui.md
- Brian 是否已確認：是

## 2026-10-06 依另一條字幕對齊

- 原本：自動對齊只依片子的聲音（人聲偵測、語音辨識）。
- 改成：可以選同一部片的另一條字幕當參考來對齊。`POST /api/subtitles/:id/auto-align` 多一個選填的 `referenceId`；`AlignResult` 多 `reference`（含參考字幕本身離片中人聲多遠的 `offBy`）、`extraLines`，`method` 多 `reference`、`reference-text`、`reference-llm`（最後一個目前不會出現，保留給以後）。開頭結尾的製作資訊不參與計算，對齊後列出來讓使用者決定要不要刪；拆句、併句不影響。
- 原因：Brian 在對話裡要求（對好一條字幕之後，可以幫其他字幕對齊；要考慮開頭與電影無關的資訊、一句對兩句）。
- 改了哪些檔案：packages/shared/src/contracts/api.ts、docs/04-api.md、docs/08-media-pipeline.md、docs/09-sync-workbench.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 版面改成視窗不捲動，列表在自己的框裡捲動

- 原本：整頁一起捲動。
- 改成：頂端列和選單固定，視窗不捲動；列表頁的列表、其他頁的每個表格在自己的框裡捲動；手機的選單變成一列左右滑。下載細節頁的地圖、每一塊、速度改成分頁；節點加上國旗。見 docs/17-ui.md 的「版面」。
- 原因：Brian 在對話裡要求（有列表的地方用容器包起來，不要讓整個頁面滑；細節頁用分頁；加國旗）。他也回報「所有頁面都可以滑到很下面、下面是空白」，在這台機器的 Chrome 重現不出來；改成視窗不捲動後，這種情況不會再發生。
- 改了哪些檔案：docs/11-pages.md、docs/17-ui.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 下載頁加海報和下載細節頁

- 原本：下載頁每一列左邊是一塊顏色，沒有細節頁。
- 改成：每一列有海報，片名連到新的「下載細節」頁：節點世界地圖（連線像網路攻擊即時地圖那樣畫成弧線）、每一塊的狀態格子、速度曲線、節點表。新端點 `GET /api/torrents/:id/live`、合約 `TorrentLive`、資料表 `torrent_live`（遷移 `0004`）、映像檔裡的 DB-IP 國家對照表。
- 原因：Brian 在對話裡要求（海報、可以點開看下載細節、地圖顯示節點並連線、用格子顯示每一塊）。
- 改了哪些檔案：docs/03-data-model.md、docs/06-torrent-worker.md、docs/11-pages.md、db/schema.sql、packages/shared/src/contracts/api.ts
- Brian 是否已確認：是（他提出的）；伺服器位置用時區推、IP 遮一半、DB-IP 的資料是我決定的

## 2026-10-06 電影資料改用 TMDB，取代 IMDb

- 原本：搜尋和電影頁的片名、簡介、海報、評分都是 YTS 給的（評分是 IMDb 的）；TMDB 只用來換編號和查中文片名。
- 改成：有 TMDB 金鑰時，中文片名（放在前面）、中文簡介、海報、評分都來自 TMDB，評分標明來源，電影頁有「在 TMDB 查看」。沒有金鑰時退回 YTS。合約多了 `MovieSummary.tmdbId`、`ratingSource`，`MovieDetail.tmdbUrl`。篩選和排序的評分仍是 YTS 的 IMDb 評分（只有它能篩整個片庫）。
- 原因：Brian 在對話裡要求「use TMDB API, replace imdb」，範圍選了全部（評分、電影資料、TMDB 連結、字幕查詢用 TMDB 編號）。
- 改了哪些檔案：docs/05-yts.md、docs/11-pages.md、docs/12-auth.md、docs/13-settings.md、packages/shared/src/contracts/api.ts
- Brian 是否已確認：是（他提出的）

## 2026-10-06 外觀改成角落的一個按鈕

- 原本：外觀是一組三選一的按鈕（淺色／深色／跟隨系統），放在帳號選單、個人設定、登入頁底部。
- 改成：一個圖示按鈕，放在頂端列右側和登入類頁面的右上角，每按一次換下一種，圖示轉一圈。個人設定拿掉「外觀」區塊。
- 原因：Brian 在對話裡說不喜歡三個按鈕佔位置，要放在角落、一個按鈕輪流切換。
- 改了哪些檔案：docs/11-pages.md、docs/17-ui.md
- Brian 是否已確認：是（他提出的）

## 2026-10-06 假的字幕來源也替本機做種的那部片回答

- 原本：docs/15-testing.md 寫假的字幕來源只有 *Inception*（`tt1375666`）有結果。但假 YTS 上由本機做種的是 *Charade*（`tt9000002`），所以「離線的完整流程」走到找字幕時每個來源都是 0 筆，`pnpm dev` 也一樣，只能自己上傳。
- 改成：`startFakeSources({ answerAsInception: [...] })` 把列出的 IMDb 編號當成 *Inception* 回答（TMDB、SubDL、YIFY 依 IMDb 查；JustSubtitles 依 TMDB 查到的 27205）。`pnpm dev` 的假來源和端對端測試都替 `tt9000002` 回答。錄下來的回應不變。
- 原因：階段 9 的完整流程測試要能從真的搜尋結果加入字幕。
- 改了哪些檔案：docs/15-testing.md、tools/fakes/src/subtitles.ts、tools/fakes/src/subtitles-cli.ts、scripts/dev.mjs
- Brian 是否已確認：不需要

## 2026-10-06 自動對齊加上語音辨識和語言模型

- 原本：自動對齊只看人聲偵測（ffsubsync 兩種、對齊核心），在配樂多的真實影片上會選錯（階段 0 的 Tears of Steel 五種情境全錯）。
- 改成（Brian 在對話裡指定的做法：Whisper 或通義千問的 ASR，分批、不跑整部片，再用語言模型對齊不同語言的字幕）：
  - 分析之後多一步語音辨識（faster-whisper `base`，平均分布的 30 秒窗，最多 6 分鐘），`media_files.asr_state`、`asr_language`，結果 `asr.json`。遷移 `0002_asr.sql`。
  - 辨識結果和字幕配對：同語言用文字比對；不同語言用語言模型（Claude 或 OpenAI 相容的服務，如通義千問），在 `api` 裡呼叫。配對擬合成一個新候選 `asr` / `asr-llm`，並且當裁判：反駁配對的候選出局。
  - 新設定 `align.asr`、`align.llm.{provider, model, baseUrl}`，新金鑰 `llmKey`。`MediaStatus.asr`、`MediaErrorCode` 的 `ASR_FAILED`、`AlignResult` 的 `heard` 和兩個新方法名稱。
  - 映像檔多了 `/opt/asr`（約 300 MB）。
- 原因：Brian 的要求；實測 Tears of Steel 五種情境從最多錯 79 秒變成全部 0.03 秒以內。
- 改了哪些檔案：docs/03-data-model.md、docs/04-api.md、docs/08-media-pipeline.md、docs/12-auth.md、docs/13-settings.md、db/schema.sql、packages/shared/src/contracts/api.ts
- Brian 是否已確認：做法是他指定的；細節（窗的數量、`base` 模型、排名不用語言模型、語言模型在 api 裡呼叫）還沒確認

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

## 2026-10-06 字幕來源：沒有佇列、下載移到 api、三種壓縮檔都用 bsdtar

- 原本：
  - `docs/07-subtitle-providers.md`、`docs/02-architecture.md` 用佇列把工作交給別人：`subtitle.resolve` 把臨時的下載網址放進 `subtitle.fetch` 的工作內容，由 `media` 下載並處理。
  - zip 用 Node 的函式庫，7z 和 rar 用映像檔裡的工具。SRT、VTT 用解析函式庫。
  - 同一個來源重新搜尋時，所有還沒抓的候選都被取代（`docs/agent-notes.md` 記下的問題：只查英文會清掉中文的候選）。
  - 確認時 `doc_rev` 要不要加 1 沒寫。
- 改成：
  - 和 `media` 服務一樣沒有佇列，資料表就是待辦：`running` 的 `subtitle_searches` 是待做的查詢，`fetching` 而還沒有暫存資料夾的候選是待下載的。`api` 每個來源一條線，重啟時從資料表接著做。
  - **下載由 `api` 做**：問到網址就下載，放進和上傳相同的 `/data/tmp/uploads/<候選 id>/`（加 `manifest.json`），`media` 只負責處理（解壓縮、轉碼、解析、判斷語言）。上傳和下載走同一個處理工作。`media` 不再需要連外。
  - zip、7z、RAR5 都用 `bsdtar`：先列出項目檢查規則，再只把字幕檔一個一個讀到程式裡、邊讀邊算大小，由程式自己寫檔。`bsdtar` 不寫磁碟。
  - SRT、VTT 用自己寫的小解析器（規則簡單，有測試），不加相依套件。
  - 重新搜尋只取代這次搜尋涵蓋的語言裡、還沒抓過或抓失敗的候選；來源失敗時什麼都不取代。
  - 確認不加 `doc_rev`（文件沒變）。
  - 自動對齊在這個階段就用了兩種方法（ffsubsync 加對齊核心），排名也是；計算放在 `computeAlignment(speech, cues, opts, extraCandidates)`，之後別的方法（例如語音辨識）只要多給候選。
- 原因：射手網的下載網址是臨時的，不能存進資料表，而沒有佇列就沒有地方暫放；由拿得到金鑰的 `api` 直接下載最單純。`bsdtar` 階段 0 已經驗證過三種格式，一套做法、一套檢查比兩套好；讓它只輸出到 stdout，路徑和符號連結就沒有落地的機會。語言的取代範圍是交叉比對時發現的缺陷。
- 改了哪些檔案：docs/02-architecture.md、docs/03-data-model.md、docs/07-subtitle-providers.md、docs/10-storage.md、docs/15-testing.md
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
