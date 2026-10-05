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
