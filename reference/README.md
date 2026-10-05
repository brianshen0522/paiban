# 參考程式

這裡的每一樣都實際跑過。原本在這裡的對齊核心（`sync-core/`）已經搬到 `packages/shared/src/sync-core/`。它們不是產品，是讓實作時不用從零摸索的起點：有的會直接搬進專案，有的是示範做法。

| 資料夾 | 內容 | 怎麼跑 | 之後怎麼用 |
| --- | --- | --- | --- |
| `pipeline/` | `analyze.sh`（探測、波形、人聲）、`preview.sh`（聲音檔、預覽檔）、`mux.sh`（封裝）、`align.ts`（自動對齊的完整流程）、`peaks.mjs`、`npz_to_speech_json.py` | 需要 ffmpeg 和裝有 ffsubsync 0.5.1 的 Python（用環境變數 `FFSUBSYNC`、`FFS_PYTHON` 指到虛擬環境裡的執行檔）。每個檔案開頭有用法 | 邏輯改寫進 `media` 程式；指令的選項照用 |
| `subtitles/` | 位元組變文字（編碼）、判斷語言與繁簡、簡轉繁、ASS 轉純文字。5 項測試 | `cd subtitles && npm ci && npm test` | 改寫成 TypeScript，測試一起搬 |
| `torrent/` | WebTorrent 的離線測試：只憑 info hash 下載、暫停與接續、刪除 | `cd torrent && npm ci && npm test` | `torrent` 程式的做法依據；整合測試照這個方式做種 |
| `providers/` | 各外部來源回應的形狀 | 純資料 | 階段 0 用真實回應換掉後當測試素材 |

測試素材在 `../fixtures/`。每一道指令為什麼這樣寫，在 `../docs/08-media-pipeline.md`。

實測環境：Ubuntu 24.04、2 核心、Node 22.22 與 24.21、ffmpeg 6.1.1、Python 3.11 與 3.13、ffsubsync 0.5.1、webtorrent 3.0.21、TypeScript 7.0.2。

`.ts` 檔是在這組設定下檢查的：`strict`、`module` 和 `moduleResolution` 是 `NodeNext`、`allowImportingTsExtensions`、`erasableSyntaxOnly`、`noUnusedLocals`、`noUnusedParameters`。沒有開 `noUncheckedIndexedAccess`；要開的話對齊核心得先改一輪（會多出幾十個錯誤）。

三個有 `package.json` 的資料夾都附了 `package-lock.json`，用 `npm ci` 安裝。`torrent/` 裝的 webtorrent 會帶進一個有安全通報的相依套件，說明在 `../docs/16-risks.md`。
