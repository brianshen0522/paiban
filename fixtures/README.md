# 測試素材

這裡的每一個檔案都是為這個專案合成的：對白是寫的、聲音是文字轉語音、畫面是 ffmpeg 畫的。**沒有任何第三方的影音或字幕內容**，可以放進 repo、放進測試、放進 CI。

## 影片

一段 92.4 秒的「電影」：兩個人（A、B）在辦公室找一捲帶子，共 26 句英文對白。畫面是兩個方塊，誰在講話誰就亮起來，下方是波形，左上角是時間碼。第 13 句和第 14 句之間有 13 秒沒有對白（只有幾聲翻東西的悶響）；第 22 句之前有一聲電梯的提示音。背景有很輕的底噪和持續音，讓人聲偵測不是在完全安靜的環境下工作。

| 檔案 | 內容 | 用途 |
| --- | --- | --- |
| `clip.mp4` | H.264 8-bit、480×270、23.976 fps、AAC 單聲道。1.4 MB | 「能直接播」的版本。下載、分析、同步、匯出的主要素材 |
| `clip.hevc10.mp4` | 同樣的畫面，HEVC 10-bit、AAC 5.1。2.3 MB。每一格的時間戳和 `clip.mp4` 相同 | 「不能直接播」的版本：聲音檔要轉檔、要做預覽檔 |
| `clip.webm` | 同樣的內容，VP9 + Opus。2.4 MB | **Playwright 內建的 Chromium 不能解碼 H.264。** 需要真的播放影片的瀏覽器測試用這個。它也算「能直接播」的版本（規則在 `docs/08-media-pipeline.md`） |

## 分析結果

| 檔案 | 內容 |
| --- | --- |
| `data.json` | 原型用的資料包：`duration`、`fps`、`speechHz`（100）、`speechFrames`（9242）、`speech`（42 段人聲，單位是 10 毫秒的影格）、`peaksPerSec`（50）、`peaks`（base64；4,620 組最小值與最大值的有號位元組）、`cues`（26 句，每句有 `id`、`start`、`end`、`zh`、`en`、`who`） |
| `clip.npz` | ffsubsync 對 `clip.mp4` 做人聲偵測的快取（`--vad webrtc`）。裡面的 `speech` 陣列和 `data.json` 的 `speech` 是同一份資料 |

對 `clip.mp4` 跑 `reference/pipeline/analyze.sh`，產生的 `speech.json` 和 `peaks.bin` 要和 `data.json` 裡的完全相同。

另外兩個檔案的聲音重新編碼過，人聲偵測的結果有極小的差異，拿它們做測試時不要比對完全相等：

| 檔案 | 和 `clip.mp4` 相比 | 對測試的影響 |
| --- | --- | --- |
| `clip.hevc10.mp4` | 大約 1% 的影格不同 | 分數差不到 1 個百分點 |
| `clip.webm` | 9,242 個影格裡 28 個不同（偵測出 44 段人聲，不是 42 段） | 分數是 79.5% 上下，顯示成 79%（`clip.mp4` 是 79.6%，顯示成 80%）。自動對齊算出來的位移、速率、分段和 `clip.mp4` 完全相同 |

用 `clip.webm` 的測試，比對分數時容許正負 1 個百分點。

`cues` 的時間是「字幕人員會下的時間」：比台詞早 0.05 秒出現、台詞結束後多留 0.35 秒、不和下一句重疊。所以正確的字幕和人聲的重疊比例是 80%，不是 100%。

## 字幕

`truth.*` 是時間正確的字幕。其他是故意弄錯的，模擬下載來的字幕常見的三種問題。

| 檔案 | 問題 | 把它對回去需要 |
| --- | --- | --- |
| `truth.zh-TW.srt`、`truth.en.srt` | 沒有 | |
| `late.zh-TW.srt` | 整體晚 2.4 秒 | 位移 −2.4 |
| `rate.zh-TW.srt` | 是給 25 fps 的版本做的（`t × 23.976 / 25 + 0.8`） | 速率 ×1.0427，位移 −0.834 |
| `cut.zh-TW.srt` | 這份字幕的版本在第 13 句之後少了一段 12 秒的戲（前 13 句 `t − 1.2`，之後 `t − 13.2`） | 兩段：+1.2 和 +13.2 |

同一份 `late` 字幕的其他編碼和格式：

| 檔案 | 測什麼 |
| --- | --- |
| `late.zh-TW.big5.srt` | Big5 |
| `late.zh-TW.utf16le-bom.srt` | UTF-16 LE、有 BOM、CRLF 換行 |
| `late.zh-CN.srt` | 簡體（UTF-8），用 opencc-js 從繁體轉的 |
| `late.zh-CN.gb18030.srt` | 簡體，GB18030 |
| `late.zh-CN.to-zh-TW.expected.srt` | 上面的簡體轉回繁體（`cn` → `twp`）應該得到的結果 |
| `late.bilingual.ass` | ASS：每句中英兩行、有樣式標記、另有一行註解和一行繪圖指令（都應該被略過）。UTF-8 帶 BOM、CRLF |
| `late.en.vtt` | WebVTT |
| `archive.zip` | 字幕網站常見的壓縮檔：一個 Big5 的繁體字幕、一個英文字幕、一個說明文字檔、一個 `__MACOSX` 的雜檔 |

還沒有、需要在階段 0 自己準備的：`.rar` 和 `.7z` 的壓縮檔（準備這份素材的環境裡沒有能產生它們的工具）、惡意的壓縮檔（路徑含 `..`、含符號連結、解開後超過上限）。

## ffsubsync 的結果

| 檔案 | 內容 |
| --- | --- |
| `ffsubsync/<情境>.linear.out.srt` | `ffsubsync clip.npz -i <情境>.zh-TW.srt -o …` 的輸出 |
| `ffsubsync/<情境>.split.out.srt` | 加上 `--split-penalty` 的輸出 |
| `expected.ffsubsync.json` | 每次執行 ffsubsync 自己印出的位移、速率、分段，以及和 `truth` 比較的誤差 |

有了這些，解析 ffsubsync 輸出、還原變換、挑選結果的程式不用安裝 ffsubsync 就能做單元測試（`reference/sync-core/core.test.ts` 就是這樣做的）。

## 比較長的素材

`film/film.json`：一部 21.5 分鐘合成影片的人聲資料（557 段）和四份字幕（各 180 句）：`truth`、`late`（+2.37 秒）、`pal`（`t × 23.976 / 25 + 1.1`）、`cut`（第 33 句之後少了 40 秒）。影片本身太大沒有附；這個檔案足夠測對齊核心在比較長、落差比較大的情況下的行為。這裡的 `truth` 是每句台詞實際發聲的區間，所以正確字幕的分數是 95%。

## 重新產生

```bash
# 在 fixtures/ 這個資料夾裡執行。

# 簡體版和轉換的預期結果。用的是 reference/subtitles 裝的 opencc-js:
(cd ../reference/subtitles && npm ci)
node make_simplified.mjs

# 其他全部。用裝有 ffsubsync 0.5.1 的那個 Python 來跑(它會用到 ffsubsync 帶進來的 srt 套件):
FFSUBSYNC=/path/to/venv/bin/ffsubsync /path/to/venv/bin/python make_fixtures.py
```

`clip.mp4` 和 `data.json` 是來源，不會被重新產生。另外兩個影片檔是從 `clip.mp4` 轉的：

```bash
# clip.hevc10.mp4(實際用的指令)
ffmpeg -i clip.mp4 -map 0:v:0 -map 0:a:0 -c:v libx265 -preset medium -crf 30 -pix_fmt yuv420p10le -tag:v hvc1 \
  -fps_mode passthrough -c:a aac -ac 6 -b:a 192k -movflags +faststart clip.hevc10.mp4

# clip.webm(當時的參數沒有留下來;類似這樣)
ffmpeg -i clip.mp4 -c:v libvpx-vp9 -crf 34 -b:v 0 -fps_mode passthrough -c:a libopus -b:a 64k clip.webm
```
