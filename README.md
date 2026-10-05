# 拍板 Paiban：實作交接包

拍板是一個自己架的網站：搜尋電影、下載、找字幕、在網頁上把字幕對準，最後輸出帶字幕的 MKV。

這個資料夾裡是開始實作需要的全部東西：規格、可以操作的原型、跑過的參考程式、測試素材。**這裡還沒有任何產品的程式碼**；它是專案的起點，實作出來的東西會直接長在這個資料夾裡。

## Brian：怎麼開始

1. 把這個資料夾放到你要開發的地方（它之後就是專案的 repo）。那台機器要有 Docker、網路、git 和 Node.js；最好就是之後要架站的那一台。細節在 [PROMPT.md](PROMPT.md) 的「貼之前」。
2. 在這個資料夾裡開啟你的 coding agent。
3. 把 [PROMPT.md](PROMPT.md) 裡的啟動 prompt 貼給它。

它會先讀文件、在映像檔裡跑一遍參考測試、對真實的來源做確認，然後停下來向你回報。之後每個階段都是這樣：做完、回報、等你說繼續。`PROMPT.md` 裡也有後續階段要貼的句子。

想先自己看一下要做的東西長什麼樣子：用瀏覽器打開 `prototype/platform/index.html`。

有些預設值是準備這份交接包時先定下來的（做種、限速、同時下載幾部、管理員的權限範圍…），列在 [docs/16-risks.md](docs/16-risks.md) 最後的「請 Brian 確認的事」。有空看一下；不看也不會擋住開工，coding agent 會在第一份報告裡再問一次。

## 資料夾內容

| 路徑 | 內容 |
| --- | --- |
| `PROMPT.md` | 貼給 coding agent 的啟動 prompt，以及後續階段用的 |
| `AGENTS.md` | 給 coding agent 的工作規則。多數工具會自動讀它（`CLAUDE.md` 只是把它引入） |
| `docs/` | 規格，18 份文件。見下方的閱讀順序 |
| `contracts/api.ts` | API 的合約：每個端點的請求與回應型別、錯誤碼、即時事件 |
| `db/schema.sql` | 資料庫的參考 schema，含用量計算與空間檢查的函式；`schema.test.mjs` 是它的測試 |
| `deploy/` | Docker Compose、Dockerfile、Caddyfile、`.env` 的範例 |
| `prototype/platform/` | 整個平台的可操作原型（單一 HTML 檔）、原始碼、30 張截圖、自動化檢查 |
| `prototype/workbench/` | 字幕同步工作台的獨立原型，同上 |
| `reference/sync-core/` | 對齊核心的 TypeScript 實作與 17 項測試。會直接成為產品的一部分 |
| `reference/pipeline/` | 分析、預覽檔、對齊、封裝的可執行腳本 |
| `reference/subtitles/` | 字幕的編碼判斷、繁簡轉換、ASS 轉換，與測試 |
| `reference/torrent/` | WebTorrent 的離線測試：本機兩個用戶端互傳 |
| `reference/providers/` | 各外部來源回應的形狀範例（手寫的示意，不是真實回應） |
| `fixtures/` | 測試素材：一段合成的 92 秒影片（三種編碼）、正確與故意弄錯的字幕、各種編碼與格式、ffsubsync 的實際輸出 |
| `.gitignore`、`.dockerignore`、`.gitattributes` | 專案一開始就該有的設定：不進版本控制的東西（`.env`、`/data`、手動確認來源時的暫存 `.scratch/`）、不進映像檔的東西、以及不讓 git 更動測試素材的換行 |

## 給 coding agent：閱讀順序

先讀 `AGENTS.md`，再依這個順序讀 `docs/`。前五份是全貌，後面的在做到那個部分時細讀。

| 順序 | 文件 | 內容 |
| --- | --- | --- |
| 1 | [00-decisions.md](docs/00-decisions.md) | 已定案的決定和它們的來源。**地位最高** |
| 2 | [01-product.md](docs/01-product.md) | 這是什麼、誰在用、主流程、名詞表 |
| 3 | [02-architecture.md](docs/02-architecture.md) | 五個容器、怎麼溝通、磁碟與程式碼的配置、技術選型 |
| 4 | [14-plan.md](docs/14-plan.md) | 十個階段和每個階段的驗收條件 |
| 5 | [16-risks.md](docs/16-risks.md) | 哪些驗證過、哪些還沒有、哪些要請 Brian 確認 |
| 6 | [03-data-model.md](docs/03-data-model.md) | 資料表、狀態怎麼變、交易的邊界 |
| 7 | [04-api.md](docs/04-api.md) | 每個端點的行為、即時更新、錯誤碼 |
| 8 | [10-storage.md](docs/10-storage.md) | 容量上限的規則（不自動刪除） |
| 9 | [05-yts.md](docs/05-yts.md) | YTS 的串接 |
| 10 | [06-torrent-worker.md](docs/06-torrent-worker.md) | 下載程式 |
| 11 | [08-media-pipeline.md](docs/08-media-pipeline.md) | 分析、預覽檔、自動對齊、封裝 |
| 12 | [07-subtitle-providers.md](docs/07-subtitle-providers.md) | 四個字幕來源與上傳 |
| 13 | [09-sync-workbench.md](docs/09-sync-workbench.md) | 同步工作台 |
| 14 | [11-pages.md](docs/11-pages.md) | 每一頁：資料、狀態、文案、和原型的差異 |
| 15 | [12-auth.md](docs/12-auth.md) | 帳號、權限、安全 |
| 16 | [13-settings.md](docs/13-settings.md) | 設定項目與驗證 |
| 17 | [15-testing.md](docs/15-testing.md) | 測試策略、離線的完整流程 |
| 18 | [17-ui.md](docs/17-ui.md) | 顏色、字、元件、文案規則 |

實作過程中會新增三樣東西：`docs/agent-notes.md`（疑問與判斷）、`docs/changes.md`（偏離規格的地方）、`docs/reports/`（每個階段的報告）。格式見各自的檔案。

## 這份規格可以相信到什麼程度

準備時實際跑過的：

- 對齊核心（17 項測試）、字幕文字處理（5 項）、資料庫的用量與空間檢查（11 項）、WebTorrent 的下載與接續（Node 22 和 24）
- 所有 ffmpeg 與 ffsubsync 的指令，以及它們在測試素材上的結果
- API 合約的型別、compose 檔的語法
- 兩個原型的行為（工作台 40 項、平台 72 項檢查）
- JustSubtitles 和 YIFY Subtitles 的介面（2026-10-04 用瀏覽器查看）

還沒有驗證、需要在第一個階段確認的（完整清單在 [16-risks.md](docs/16-risks.md)）：

- **自動對齊在真實電影上的準確度。** 目前的數字全部來自合成語音
- 從架站的機器實際連到各個字幕來源；射手網、TMDB、SubDL 沒有金鑰所以沒有實際呼叫過
- Dockerfile 和 Caddyfile 沒有實際建置過
- RAR 壓縮檔的解壓工具
- ARM 的機器
- 背景工作的排程細節（認領、對帳、自動再試一次）：邏輯上對過，沒有實際跑過

## 需要 Brian 準備的東西

不用一開始就全部備齊，做到需要的階段時 coding agent 會提出。清單在 [14-plan.md](docs/14-plan.md)。最早會用到的：

- 部署機器的規格（CPU、記憶體、磁碟、x86 或 ARM）
- 目前能用的 YTS 網址
- TMDB 的 API 金鑰（免費申請）
- 射手網（偽）的 API token（註冊後取得）

金鑰請自己填進本機的 `deploy/.env`（開發階段手動確認來源時用）或上線後的管理頁（網站實際用的），不要貼在對話裡。

## 法律提醒

不是法律意見。YTS 上的內容大多沒有權利人的授權，BitTorrent 下載時也在上傳；在大多數地區這樣使用有法律風險，由架設和使用的人自行承擔。開發與測試全程只用這裡附的合成素材和可自由散布的影片。
