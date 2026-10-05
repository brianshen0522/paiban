# 原型

兩個可以直接操作的原型。它們是**畫面和行為的依據**，不是產品的程式碼：每一個都是把所有東西塞在一起的單一 HTML 檔，後端全是模擬的。照它們的樣子和行為做，不要照它們的寫法做。

## 怎麼看

用瀏覽器直接打開：

| 檔案 | 內容 |
| --- | --- |
| `platform/index.html` | 整個平台：登入、註冊、搜尋、電影頁、下載、片庫、工作區（字幕、同步、匯出）、儲存空間、個人設定，以及七個管理頁 |
| `workbench/index.html` | 字幕同步工作台，獨立的版本 |

登入頁下方有「原型捷徑」，可以直接用管理員或成員的身分進入。右上角的帳號選單可以切換身分、重設示範資料。

原型裡：

- 電影是 14 部公有領域的老片，使用者、字幕、匯出檔都是示範資料
- 搜尋、下載、字幕搜尋、排名、匯出都是模擬的；下載進度是加速 10 倍的動畫
- **同步工作台是真的可以操作的**，用的是一段 92 秒的合成影片（`fixtures/clip.mp4`，已經嵌在 HTML 裡）。同步頁上方的選單可以切換三種「字幕哪裡錯了」的情境
- 字型從 Google Fonts 載入；沒有網路時會用系統字型，版面一樣

## 資料夾

```
platform/
  index.html          建置好的原型
  src/                原始碼
    app1.js           示範資料、模擬的後端(用量計算、下載排程、候選字幕)
    app2.js           登入、外框、搜尋、電影頁、下載、片庫、工作區、儲存空間、個人設定
    app3.js           七個管理頁
    app4.js           路由、所有動作、表單驗證、提示訊息的文字
    app.css           平台的樣式(設計 token 在最上面)
    bench.html / bench.css / bench-ui.js    嵌進平台的工作台
    core.js / scenarios.js / data.json      對齊核心、三種示範情境、示範片段的資料
    page.html         組裝用的樣板
  screenshots/        30 張截圖,編號對應 docs/11-pages.md
  build.py            組裝成單一 HTML
  e2e.cjs             自動化檢查,72 項
workbench/
  index.html
  src/                core.js、scenarios.js、ui.js、style.css、template.html、data.json、test_core.js
  screenshots/        7 張
  build.py
  e2e.cjs             自動化檢查,40 項
```

找某一句文案或某個行為時，直接在 `src/` 裡搜尋那句中文。

`core.js` 是對齊核心的原始版本；整理成 TypeScript、補上測試的版本在 `packages/shared/src/sync-core/core.ts`，以那個為準。

## 重新建置與檢查

```bash
cd platform                # 或 workbench
python3 build.py           # 產生 index.html
python3 build.py --webm    # 產生 preview_webm.html,給自動化檢查用
node e2e.cjs               # 需要 playwright 套件和它的 Chromium
```

自動化檢查用 WebM 版的影片，因為交接時的 Playwright Chromium 不能解碼 H.264（Playwright 1.63 的可以，見 `docs/15-testing.md`）。跑完會重新產生 `screenshots/`。

## 原型和正式版不同的地方

列在 `docs/11-pages.md`（每一頁）和 `docs/09-sync-workbench.md`（工作台）的最後。最重要的幾項：

- 原型裡標著「原型捷徑」「原型開關」「示範資料」的東西，正式版都不要
- 下載設定的連入埠在正式版是唯讀的
- 自動對齊在正式版由伺服器計算
- 預覽檔的預留空間在正式版比原型顯示的大
- 介面文案的標點在正式版用全形
- 原型可以用中文片名搜尋（示範資料自帶中文片名）；真的 YTS 只認英文片名，正式版不做
- 原型的個人偏好（語言、畫質、第二語言）改了不會影響其他頁面；正式版要接上
- 原型有幾處用右下角的提示訊息顯示錯誤；正式版把錯誤放進頁面裡（對照表在 `docs/11-pages.md` 的「外框」）
- 原型裡的大小是寫死的示範數字；正式版從位元組算，不會一模一樣
- 檢查點在原型是 5 個、文案裡寫了「五」；正式版預設 8 個，文案不寫數字
