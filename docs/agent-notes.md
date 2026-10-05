# 實作筆記

讀規格和實作時遇到的疑問、矛盾、缺漏，以及當下怎麼判斷。最新的寫在最上面。

每一則的格式：

```text
## 2026-10-12 預覽預留在片長是 0 的時候怎麼算

- 在哪裡：docs/10-storage.md、docs/05-yts.md
- 問題：……
- 判斷：……（依據：docs/00-decisions.md 的 D24）
- 需要 Brian 確認：是 / 否
```

需要 Brian 確認的，在下一份階段報告裡再列一次。

---

## 2026-10-05 自動對齊的分段模式在真實電影上會產生假斷點

- 在哪裡：docs/08-media-pipeline.md「自動對齊」、`packages/shared/src/sync-core/core.ts` 的 `autoAlign`（`allowSplit`）與 `pickAlignment`
- 問題：階段 0 第 6 項在 *Tears of Steel*（12 分鐘、76 句官方英文字幕）上量到：ffsubsync 單一位移在「原樣、晚 2.4 秒、晚 23.7 秒、影格率不同」四種情境都在 0.034 秒以內；但對齊核心允許分段時，每一次都把最後 17 句另外切成一段、往前搬 38 秒（那裡剛好有別的人聲），分數反而比較高（0.717 對 0.672），`pickAlignment` 每次都選中它，所以**最後選出來的結果有 22% 的句子錯了 38 秒**，`agree` 是 false。關掉分段時兩種方法一致、位移 0.03 秒。「剪輯版本不同（中間少 12 秒）」的情境，兩種方法都沒找回來。
- 判斷：不在階段 0 改演算法（它屬於階段 6）。階段 6 要處理：分段的懲罰（目前 3 秒台詞）在真實電影上太小；一段至少要有幾句、要比單一位移好多少才成立；兩種方法不一致時的挑法。報告列出量測數字和建議。
- 需要 Brian 確認：否（屬於階段 6 的調整，D33 的做法不變）。但結果寫在報告最前面。

## 2026-10-05 配樂很重的片，webrtc 人聲偵測抓不到對白

- 在哪裡：docs/08-media-pipeline.md「人聲偵測」、docs/16-risks.md 第 1 項
- 問題：*Sintel*（15 分鐘、26 句、配樂很重、對白輕）偵測出的「人聲」只佔 14%，而且大多不是對白：正確字幕的分數只有 20%（26 句裡 25 句低於 50%）。五種情境兩種方法全部對錯（誤差中位數 12 到 79 秒）。*Tears of Steel* 正常（正確字幕 67%，人聲 48%）。試了 ffsubsync 的 `--vad silero`：要另外裝 torch（環境 5.3 GB），跑得完，但輸出整份都是 0；ffsubsync 0.5.1 和目前的 silero-vad 模型不相容，沒有得到有意義的結果。
- 判斷：產品仍然成立（手動工具不依賴偵測，16-risks 第 1 項已經這樣預期）。但「自動對齊」在這類片上會給出錯的結果，而且分數低、`agree` 是 false：介面一定要在這種情況下明講「自動對齊不可靠，請用對齊點」。換偵測方法（silero 要修相容性、或 whisper）是要 Brian 決定的取捨（映像檔大小、CPU）。
- 需要 Brian 確認：是（要不要在階段 6 投入另一種人聲偵測；見報告）

## 2026-10-05 分數門檻在真實電影上偏高

- 在哪裡：docs/08-media-pipeline.md「對齊分數」、docs/16-risks.md 第 14 項
- 問題：正確的官方字幕在 *Tears of Steel* 的總分是 67%（門檻是 70% 綠、55% 黃），76 句裡 22 句低於 50%、5 句低於 25%（單句的門檻是 50%、25%）。也就是對得正確的字幕會顯示黃色，三成的句子是黃或紅。
- 判斷：門檻本來就是共用常數。階段 6 用更多真實素材再定；現在只記下數字。
- 需要 Brian 確認：否

## 2026-10-05 被動的連入觀察會被 UDP 打洞誤判

- 在哪裡：docs/06-torrent-worker.md「連入狀況」、D32
- 問題：階段 0 第 5 項在 Docker bridge 網路、只在 compose 發布埠、不確定路由器有沒有轉發的情況下，下載期間觀察到 1 個 `utpIncoming`。uTP 走 UDP，我們先連出去之後 NAT 會短暫允許對方從同一個埠連回來，所以一個 `utpIncoming` 不能證明埠有轉發。`tcpIncoming` 一個都沒有。
- 判斷：建議只用 `tcpIncoming` 判斷「埠是通的」，`utpIncoming` 只記錄不採信。屬於「交接」的 D32 的細節，可以直接採用；先記在這裡，階段 3 實作時改 06 並記 changes。
- 需要 Brian 確認：否。但想知道：路由器上有沒有轉發 51413（TCP/UDP）和 51414（UDP）？

## 2026-10-05 本機的 8080 埠已經被別的專案用了

- 在哪裡：deploy/.env、`.env.example` 的 `HTTP_PORT=8080`
- 問題：這台機器上另一個專案（forward）佔用 8080。
- 判斷：只改本機的 `deploy/.env`：`HTTP_PORT=8088`、`HTTPS_PORT=8448`、`PUBLIC_URL=http://localhost:8088`。`.env.example` 的預設值不動。
- 需要 Brian 確認：否

## 2026-10-05 Playwright 內建的 Chromium 其實能解 H.264

- 在哪裡：docs/15-testing.md「瀏覽器測試的注意事項」、docs/08-media-pipeline.md、fixtures/README.md
- 問題：文件說內建的 Chromium 不能解 H.264，所以端對端測試用 WebM。實測 Playwright 1.63 的 Chromium（HeadlessChrome 153）能播 H.264 High + AAC（含 5.1）的 MP4、能拖動，畫面真的有解碼（`getVideoPlaybackQuality` 有影格、畫面不是黑的）。
- 判斷：以實為準修正文件的說法。WebM 那條路（把 WebM 算成能直接播、端對端測試用 `clip.webm`）不用拿掉：它不依賴這件事，而且 Playwright 換版本時這件事可能又變。記在 changes。
- 需要 Brian 確認：否

## 2026-10-05 bsdtar 解壓縮時不替我們設任何限制

- 在哪裡：docs/07-subtitle-providers.md「下載與處理」第 3 步、docs/12-auth.md「上傳與壓縮檔」
- 問題：映像檔裡的 bsdtar 3.7.4 能解 zip、7z、RAR5。對惡意壓縮檔：含 `..` 的項目拒絕（結束碼 1，但其他項目照樣解出來）、開頭的 `/` 自動去掉、**符號連結照樣解出來**、項目數量和解開後的大小**完全不限制**（60 MB 的炸彈照解）。
- 判斷：階段 5 照規格自己檢查：先 `bsdtar -tvf` 列出項目，有符號連結、絕對路徑、`..`、超過 200 項、宣告的大小超過上限就整包拒絕；解的時候再用實際寫出的位元組數檢查一次（標頭寫的大小可以造假）。zip 規格寫「用 Node 的函式庫」；三種格式都用 bsdtar 比較單純，階段 5 決定並記 changes。惡意壓縮檔的測試素材已經做好放在 `fixtures/archives/`。
- 需要 Brian 確認：否

## 2026-10-05 JustSubtitles 的 `ZH` 分類裡是繁體字幕

- 在哪裡：docs/07-subtitle-providers.md「語言」
- 問題：階段 0 從 JustSubtitles 的 `ZH`（名義上簡體）下載的第一個檔案是 `.hk.srt` 的繁體字幕（UTF-8、沒有 BOM）；YIFY 的 `Chinese` 也是繁體（UTF-8 有 BOM）。
- 判斷：和文件「來源標的語言只能當參考、依內容重新判斷」一致，不用改。用 `reference/subtitles` 的判斷函式兩個都正確判成 `zh-Hant`。
- 需要 Brian 確認：否

## 2026-10-05 讀規格時發現的矛盾與缺漏（階段 1 之後的部分）

`docs/03`、`04`、`09`、`11`、`13`、`17` 與 `packages/shared/src/contracts/api.ts`、`db/schema.sql` 的交叉比對由一個輔助的審閱流程做，我抽查了其中三條（第 1、2、4 條），都屬實。其餘的在做到那個階段時再逐條確認、再改文件和合約。依 AGENTS.md 的順序，這些都可以由我判斷，不需要 Brian 決定；列在這裡是讓做到那裡時不會漏掉。

會讓規格照字面做不出來的：

1. `media_files.error` 只有一格（`db/schema.sql` 第 233 行、`MediaStatus.error`），不同資產的錯誤會互相蓋掉：先記了 `NO_AUDIO`，之後預覽影片失敗就把它蓋掉，工作台說不出「為什麼沒有波形」。建議依資產分開記。階段 4。
2. 廣播的事件裡有依收件人而不同的欄位：`{type:'torrent', torrent: Torrent}` 送給所有持有人，但 `Torrent.mine` 是依呼叫者算的；`Export.canDelete` 也一樣。建議 `api` 對每條 SSE 連線各自序列化。階段 1/3。
3. 暫停、繼續、下載的回應看不出「馬上開始還是要排隊」，11 卻要依這個選提示文字；「回到佇列尾端」沒寫是誰更新 `queued_at`（03 說 `api` 只寫 `want`）。階段 3。
4. `ProviderStatus.error.code` 沒有 `INVALID_KEY`：射手網 `20001` 在查詢時記成 `NOT_CONFIGURED`、在測試時卻是 `INVALID_KEY`，畫面會說「還沒設定 token」而其實是 token 無效；JustSubtitles 的 subdl 模式缺金鑰時畫面會說成缺 TMDB 金鑰。階段 5。

影響正確性的（摘要）：通知的連結種類不夠（`item.deleted` 要去片庫、匯出通知要去儲存空間頁，`link.page` 只有兩種）；重新搜尋會把別種語言還沒抓的候選一起取代；沒有聲音軌的片按「轉預覽檔」會白做聲音檔；工作台缺「沒有可播放的來源、也沒有東西在做」這一種狀態；總覽頁的「下載失敗」連到的頁面預設看不到別人的下載；管理員看全站下載時沒有事件觸發更新；`DISK_LOW` 沒有門檻；改容量上限的錯誤碼和單位沒寫；`LAST_ADMIN` 只有兩位管理員同時互相降級時才會發生，要用鎖；`ACCOUNT_DISABLED` 要在密碼正確之後才回；GET 不改資料的例外清單漏了 session 延長和 `users.last_seen_at`；建立匯出的幾種驗證錯誤沒有錯誤碼；12 的檢查清單和 04（建立者離開片庫後仍能下載自己的匯出檔）衝突；「匯出的 MKV 不受影響」對還沒做完的匯出不成立；預設匯出檔名固定寫 `zh-TW`。

小的：`MovieSummary.mine` 把失敗的下載歸成「下載中」；`MediaStatus` 沒有影像編碼欄位但頁首要顯示；12 的操作紀錄表裡 `subtitle.confirm` 的「同上」指錯列；下載完成時誰依 `analyzeAuto` 設 `analysis_state` 沒寫進 03 的交易表；確認時 `doc_rev` 要不要加 1、自己儲存觸發的事件要不要忽略；檢查點數量在測試裡怎麼覆寫；`NO_AUDIO` 會永遠掛在「需要處理」；`data-theme` 沒有任何東西會設它；`DISK_FULL` 的 `freeBytes` 意思沒定義。

- 需要 Brian 確認：否
