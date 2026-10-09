# 給 coding agent 的工作規則

你要在這個資料夾裡實作「拍板」（Paiban）：一個自己架的網站，用來搜尋電影、下載、找字幕、在網頁上把字幕對準，最後輸出帶字幕的 MKV。

規格、原型、參考程式和測試素材都已經在這個資料夾裡。**先讀 [README.md](README.md)，它會告訴你每樣東西在哪、依什麼順序讀。**

委託人是 Brian。他讀寫繁體中文。

## 依據的優先順序

資料之間有衝突時，前面的贏：

1. Brian 在對話裡直接說的話
2. `docs/00-decisions.md`
3. `docs/` 的其他文件：系統的**行為**以它們為準
4. `packages/shared/src/contracts/api.ts`、`db/schema.sql`：資料的**形狀**（端點清單、欄位、型別、約束）以它們為準
5. `prototype/`：畫面、文案和互動的參考
6. `reference/`：演算法和指令的參考（對齊核心、字幕文字處理、ffmpeg 與 ffsubsync 的指令、WebTorrent 的用法）

第 3 和第 4 項管的是不同的事。真的對不上時（文件提到合約裡沒有的欄位，或合約有文件沒說明的東西），行為聽文件的，然後把合約補齊，兩邊一起改。

第 5 和第 6 項也是：原型管看得到的東西，參考程式管算出來的東西。原型裡也有一份對齊核心（`core.js`），那一份以 `packages/shared/src/sync-core/core.ts` 為準。

遇到衝突或缺漏：記進 `docs/agent-notes.md`。能依上面的順序判斷的就判斷並寫下理由。要改動 `docs/00-decisions.md` 裡來源是「指定」「代決」或「假設」的決定，或你沒有把握的，停下來問；來源是「交接」的可以先照你認為更好的做法做，但要在報告裡講清楚。

**原型是行為和畫面的參考，不是架構的參考。** 它是一個把所有東西塞在一起的單一 HTML 檔，後端全是假的。照它的樣子和行為做，不要照它的寫法做。

## 絕對不能做的事

這些不因為「這樣比較方便」或「測試需要」而有例外。

1. **不寫任何會自動刪除使用者檔案的程式。** 沒有排程清理、沒有保存期限、沒有「空間不夠就清掉舊的」。能刪除 `/data` 底下檔案的只有一個指定的模組（WebTorrent 的刪檔呼叫也只從那裡發），而且每個入口都對應到某個人按下的動作（`docs/10-storage.md` 列出了僅有的幾種草稿清理例外）。
2. **不繞過驗證碼、挑戰頁或任何擋自動存取的機制。** 不偽裝成瀏覽器、不輪換標頭或 IP、不用無頭瀏覽器去抓擋爬蟲的網站。遇到就把那個來源標成不可用。
3. **不使用、不儲存、不記錄任何不屬於 Brian 的 API 金鑰。** 第三方回應裡夾帶的金鑰在解析時就丟掉。手動錄下真實回應時，寫進任何檔案之前（包含 `.scratch/`）先把金鑰換成 `PLACEHOLDER`。
4. **種子只有兩個入口：YTS 的搜尋結果，和「手動加入種子」視窗**（磁力連結或 .torrent 檔，2026-10-09 起，Brian 指定，D26）。手動加入的種子只保留 info hash、過濾過的 tracker 和 info 字典，網頁種子（web seed）和其他欄位一律丟掉，只下載裡面最大的影片檔；伺服器不替使用者去抓網址上的 .torrent。沒有其他入口（例如 API 直接帶 hash、從別的網站匯入）。（階段 0 用來了解網路狀況的那支獨立腳本不是產品的一部分；它只下載 Blender 基金會的開放電影。）
5. **開發和測試不下載有版權的影片。** 用 `fixtures/`、假的 YTS、本機做種；需要真實電影時用 Blender 基金會的開放電影。自動化測試也不使用從真實來源下載的字幕。唯一的例外是兩次手動的來源確認（階段 0 第 4 項、階段 5 的手動驗收）：每個來源下載最少數量的字幕壓縮檔，只為了確認格式，不提交、不當成測試素材（D29）。階段 0 的放在 `.scratch/`，看完就刪；階段 5 的是透過開發中的網站抓的，確認完把那幾條候選和字幕移除。
6. **自動化測試不連外部網路。**
7. **不把任何真的金鑰、密碼、token 寫進 repo、log、測試素材或對話。** 需要 Brian 的金鑰時，請他自己填進本機的 `deploy/.env` 或管理頁。你替本機產生的密碼（資料庫、`SECRET_KEY`、第一個管理員）只寫進 `deploy/.env`，那個檔案不進版本控制；報告和對話裡只說是哪個變數，不說值。測試和開發設定裡的假值（假的金鑰、測試帳號的密碼）不在此限，但要一眼看得出是假的，例如 `test-key-not-real`。
8. **不從外部網域載入任何前端資源**（字型、腳本、圖片）。網頁只向這個網站自己的伺服器發請求；使用者自己點的外部連結在新分頁開啟（D30）。

## 語言

| 東西 | 語言 |
| --- | --- |
| 程式碼、識別字、註解、commit 訊息、log | 英文 |
| 使用者看得到的所有文字 | 繁體中文（台灣用語）和英文兩份（2026-10-08 起，Brian），集中在 `apps/web/src/copy/`，元件裡不直接寫任何語言的字串 |
| `docs/` 裡的文件、給 Brian 的報告、和 Brian 的對話 | 繁體中文 |

使用者看得到的站名只出現在一個常數裡（D9）。

## 怎麼工作

- 照 `docs/14-plan.md` 的階段做。**一次一個階段，做完停下來回報，等 Brian 說繼續。**
- 每個階段開始前，重讀那個階段列出的文件。
- 小步提交，每個提交都通過型別檢查、lint 和測試。commit 訊息說明為什麼，不只是做了什麼。
- 先寫會失敗的測試，再寫實作，尤其是 `docs/15-testing.md`「一定要有的測試」那幾類。
- 偏離規格時，在 `docs/changes.md` 記下改了什麼、為什麼、影響哪些文件，並且**把那些文件一起改掉**。規格和程式不一致比規格不完美更糟。
- 不確定第三方的實際行為時，去查、去試，不要猜。查到的和文件不同就更新文件。
- 報告要誠實：沒做完的說沒做完，沒驗證的說沒驗證，測試沒過的不要說過了。
- 不要為了通過測試而改測試的預期值，除非你能說明原本的預期為什麼是錯的。
- 不加規格沒要求的功能。想到值得做的，寫進報告的建議裡。

## 品質

每個功能完成時：

- 型別完整，沒有 `any` 逃生口（第三方函式庫的邊界除外，而且要包起來）
- 有測試
- 載入中、空的、出錯的狀態都有
- 錯誤訊息說明發生了什麼、可以怎麼做
- 鍵盤可以操作，焦點看得見
- 400 px 寬不出現橫向捲軸
- 淺色和深色主題都正常
- `docs/12-auth.md` 的檢查清單沒有被違反

## 參考程式怎麼用

`reference/` 裡的東西都是實際跑過、有測試的：

- `pipeline/`：ffmpeg 和 ffsubsync 的指令。指令的每個選項都有理由（寫在 `docs/08-media-pipeline.md`），不要隨意增減。
- `subtitles/text.mjs`：編碼、語言判斷、ASS 轉換。改寫成 TypeScript，測試一起搬。
- `torrent/local-swarm-test.mjs`：WebTorrent 的用法和離線測試的做法。
- `providers/`：各來源回應的形狀。JustSubtitles、YIFY、YTS 的是錄下來的真實回應；TMDB、射手網的仍是**手寫的示意**，拿到網址或金鑰後用 `scripts/phase0/check-sources.mjs` 換掉（哪個是哪個見它的 README）。

對齊核心（`packages/shared/src/sync-core/core.ts`）和 API 合約（`packages/shared/src/contracts/api.ts`）已經從交接包搬進 `packages/shared`，瀏覽器和伺服器共用同一份。改對齊核心之前先確定它的 17 項測試還會過。

`packages/shared/src/contracts/api.ts` 和 `db/schema.sql` 是合約。要改可以，但要連同對應的文件一起改，並記在 `docs/changes.md`。`db/schema.sql` 同時就是資料庫的第一個遷移（`apps/server` 啟動時套用），見 `docs/changes.md`。

## 指令

隨著專案長出來，把實際的指令填在這裡，並保持更新。階段 0 結束時至少有安裝、型別檢查、lint、測試、建置映像檔；端對端測試和本機開發的指令在它們做出來的那個階段補上。

需要 Node.js 24、pnpm 12、Docker（含 Compose v2）。

```bash
pnpm install                                         # 安裝
pnpm typecheck                                       # 型別檢查(TypeScript 7,strict)
pnpm lint                                            # Biome:lint + 格式檢查;pnpm format 會直接修正
pnpm test                                            # 各套件的 Vitest
pnpm build                                           # 建置 shared、server、web

pnpm db:test                                         # 測試用的 PostgreSQL(port 55432);pnpm test 之前先起來
pnpm dev                                             # 本機開發:資料庫、假的 YTS、假的字幕來源(8091)、本機做種、api、torrent、media、網頁
                                                     # 打開 http://localhost:5173,用 admin / paiban-dev-not-real 登入,
                                                     # 在「來源設定」把 YTS 網址設成 http://127.0.0.1:8090

mkdir -p deploy/data                                 # 第一次:先建資料夾,否則 Docker 會用 root 建立
docker compose -f deploy/docker-compose.yml build    # 建置映像檔(paiban-server、paiban-proxy)
docker compose -f deploy/docker-compose.yml up -d    # 起五個容器;網址是 deploy/.env 的 PUBLIC_URL
scripts/phase0/reference-in-image.sh                 # 在映像檔裡跑全部參考測試與 pipeline 比對
pnpm test:image [檔案…]                              # 在映像檔裡跑伺服器測試(需要 ffmpeg、ffsubsync、bsdtar、語音辨識的那些在主機上會略過);先 pnpm db:test
pnpm test:image test/e2e-flow.test.ts                # 離線的完整流程(搜尋→下載→分析→字幕→對齊→匯出→下載 MKV→刪除),約 1.5 分鐘
SEED_EXTRA_FILM=<Blender 開放電影的路徑> pnpm dev       # 本機開發時多一個長片版本(2160p),拿來走完整流程
```

自動對齊的手動評估（真實影片，不進自動化測試）：`apps/server/scripts/asr-eval.mts`，用法在檔案開頭。部署、更新、備份見 [docs/deploy.md](docs/deploy.md)。

階段 0 的手動檢查（不進自動化測試，會連外部網路）在 `scripts/phase0/`，每支檔案開頭有用法：`check-sources.mjs`（真實的字幕來源）、`real-swarm.mjs`（真實的 BitTorrent 下載，Blender 開放電影）、`real-film.sh`（真實電影的對齊）、`make-archives.sh` / `check-archives.sh`（壓縮檔）、`playback/`（瀏覽器播放測試頁）。

現在就能跑的（確認參考程式在你的環境正常）：

```bash
(cd reference/subtitles && npm ci && npm test)
(cd db && npm ci && npm test)
(cd reference/torrent && npm ci && npm test)                  # 本機兩個用戶端互傳;成功時印出 PASS
```
