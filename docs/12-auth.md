# 12 帳號、權限與安全

這個網站是給熟人用的，但它會放在網路上、會下載檔案、會連外部網站、會執行 ffmpeg。這份文件列出必須做到的事。

## 帳號

- 帳號（`username`）：英文小寫、數字、底線，3 到 32 個字。輸入時不分大小寫，存小寫。
- 顯示名稱：1 到 20 個字，可以是中文。其他人在共用的影片、通知、紀錄上看到的是這個。
- 兩種角色：`admin`、`member`。
- 沒有電子郵件。系統不寄信。

### 第一個管理員（D18）

`api` 啟動時，如果 `users` 資料表是空的，而且環境變數 `BOOTSTRAP_ADMIN_USERNAME` 和 `BOOTSTRAP_ADMIN_PASSWORD` 都有值，就建立這個管理員。資料表不是空的就完全忽略這兩個變數。

細節：

| 情況 | 行為 |
| --- | --- |
| 資料表是空的，兩個變數都有值而且合乎規則 | 建立管理員。顯示名稱先用帳號（超過 20 個字就取前 20 個），登入後可以在個人設定改 |
| 資料表是空的，值不合規則（帳號不是 3 到 32 個英文小寫、數字、底線；密碼不到 8 個字），或只設了其中一個 | `api` 報錯結束，訊息說明是哪個變數、哪條規則。不要默默略過，否則會得到一個沒有人能登入的網站 |
| 資料表是空的，兩個變數都沒設 | 照常啟動，log 裡寫一行警告。這時沒有人能登入；設好變數、重啟就會建立 |
| 資料表不是空的 | 完全不看這兩個變數。它們留在 `.env` 裡沒有影響，但建議第一次登入後改掉密碼並把這兩行刪掉 |

密碼的值不寫進 log。

不做「第一個打開網站的人成為管理員」的設定頁：網站一上線就可能被別人搶先。

### 密碼

- 至少 8 個字，最多 200 個字。不要求大小寫或符號的組合。
- 用 argon2id 雜湊（`@node-rs/argon2` 的預設參數即可），存 PHC 格式的字串。
- 登入時帳號不存在也要跑一次雜湊比對（對一個固定的假雜湊），讓回應時間不透露帳號存不存在。
- 改密碼要輸入目前的密碼；成功後這個帳號的其他 session 全部刪除。
- 任何地方都不記錄、不回傳密碼或雜湊。

### 登入狀態

- Cookie 名稱 `paiban_session`，值是 32 個隨機位元組的 base64url。
- 屬性：`HttpOnly`、`SameSite=Lax`、`Path=/`，`PUBLIC_URL` 是 https 時加 `Secure`。
- 資料庫只存它的 SHA-256（`sessions.token_hash`）。資料庫外洩不等於 session 外洩。
- 有效 30 天。剩不到 15 天時，下次請求順便延長。`last_seen_at` 最多每 5 分鐘更新一次。
- 過期的列在查詢時被忽略，不需要程式去清。
- 「登入中的裝置」頁列出自己的 session，可以登出其他裝置。API 回的是從登入時的 User-Agent 推出來的作業系統和瀏覽器名稱（`os`、`browser`，推不出來是 null）；「Windows · Edge」和「未知的裝置」這些字是前端寫的。
- 帳號被停用、被移除、被重設密碼時，它的 session 全部刪除。

### 嘗試次數限制

| 對象 | 限制 |
| --- | --- |
| 登入，同一個帳號 | 15 分鐘內失敗 5 次就鎖 15 分鐘 |
| 登入，同一個 IP | 15 分鐘內 20 次 |
| 查邀請碼、註冊，同一個 IP | 每分鐘 10 次 |
| 查重設連結、重設，同一個 IP | 每分鐘 10 次 |

`api` 只有一個實例，計數放在記憶體裡就可以。回 `RATE_LIMITED`，帶還要等幾秒。

`api` 在 Caddy 後面，用戶端的 IP 要從 `X-Forwarded-For` 取，而且只信任來自 Docker 內部網路的這個標頭。

## 邀請

- 管理員選角色（成員或管理員）和有效期限（1、3、7 天）。
- 邀請碼的樣式是 `XXXX-XXXX`，字母表是 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（沒有容易看錯的 I、O、0、1），用密碼學等級的亂數產生。
- 連結是 `<PUBLIC_URL>/invite/<邀請碼>`。
- 一個邀請碼只能用一次。註冊時在同一個交易裡檢查「沒過期、沒用過」並標成已使用，避免兩個人同時用。
- 還沒用的可以「撤銷」，用過或過期的可以「清除」。兩者都是把那一列刪掉。

## 重設密碼（D17）

- 管理員在使用者頁按「重設密碼」，產生一個連結：`<PUBLIC_URL>/reset/<token>`。token 是 32 個隨機位元組的 base64url，資料庫只存雜湊。
- 30 分鐘有效，只能用一次。同一個帳號再產生新的時，舊的作廢。
- **連結只在產生的那次回應裡出現**，之後查不到。管理員自己私下傳給對方。
- 對方設定新密碼後，連結失效，所有 session 刪除。

## 誰能做什麼

| 資源 | 成員 | 管理員 |
| --- | --- | --- |
| 搜尋、電影頁 | 可以 | 可以 |
| 下載新的版本、加入別人的版本 | 可以 | 可以 |
| 看某個下載、進它的工作區、它的影片與字幕端點 | 只有自己持有的 | 只有自己持有的，和成員相同 |
| 暫停、繼續、重試、取消 | 只有自己持有的 | 只有自己持有的 |
| 加入、修改、確認、移除字幕 | 自己持有的那部片的任何一條（字幕是共用的） | 同成員 |
| 建立匯出 | 自己持有的那部片 | 同成員 |
| 下載匯出檔 | 那部片的持有人，或建立者 | 全部 |
| 刪除匯出檔 | 自己建立的 | 全部 |
| 看用量 | 可以（全站的數字對所有人都一樣） | 可以 |
| 看別人持有什麼 | 只能在電影頁看到「誰已下載這個版本」和共用者的名字 | 全部：全站的下載清單（唯讀）、儲存空間管理頁 |
| 強制刪除任何項目 | 不行 | 可以（儲存空間管理頁） |
| `/api/admin/…` | 不行 | 可以 |

**以某部片為對象的操作只看「是不是持有人」，管理員沒有例外。** 管理員要處理別人的片（例如幫忙對字幕），先在電影頁把那個版本加入自己的片庫，之後就和其他持有人一樣；要停掉別人的下載，用儲存空間管理頁的強制刪除。這和原型的行為一致（管理員勾了「顯示所有人的下載」之後，別人的下載只能看）。好處是權限只有一條規則，而且動過這部片的人一定在持有人名單裡。

每個端點都要在伺服器檢查，不能只靠前端不顯示按鈕。授權寫成共用的函式（`requireHolder(torrentId)`、`requireAdmin()`），每個路由明確呼叫；`requireHolder` 裡沒有「是管理員就放行」的分支。加一個測試走過所有路由，確認沒有路由漏掉檢查。

管理員不能：改自己的角色、停用自己、移除自己；也不能讓系統沒有任何啟用中的管理員（`LAST_ADMIN`）。

## 防跨站請求

- Cookie 是 `SameSite=Lax`。
- 會改變資料的請求必須帶 `X-Requested-With: paiban` 標頭（瀏覽器的跨站表單送不出自訂標頭），並且 `Origin` 要和 `PUBLIC_URL` 同源。
- 有內容的請求要帶 `Content-Type: application/json`（上傳是 `multipart/form-data`）；沒有內容的請求不要求 `Content-Type`。
- `GET` 不改變資料（`last_seen_at`、`last_used_at` 這兩個紀錄用的欄位除外）。
- 不開 CORS。

## 回應標頭

由 Caddy 加（`deploy/Caddyfile`）：`Content-Security-Policy`（只允許同源；不載入任何外部資源）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`。

`Referrer-Policy: no-referrer` 有實際的用途：使用者從這裡點連結到字幕庫或來源頁時，不會把這個網站的網址告訴對方。對外的連結另外加 `rel="noopener noreferrer"`。

網頁不從任何外部網域載入字型、腳本或圖片。字型用 npm 套件自帶，海報由伺服器代抓。

## 對外請求

伺服器會連出去的地方只有：YTS、TMDB、三個字幕來源和它們的下載主機、BitTorrent。前四類都經過一個共用的 HTTP 用戶端，它負責：

- **主機白名單**：每個來源有固定的清單（見 [07-subtitle-providers.md](07-subtitle-providers.md)），YTS 的是管理員設定的那個主機。不在清單裡的網址不連。
- **擋內部位址**：DNS 解析後，如果是私有網段、loopback、link-local、或 IPv6 的對應範圍，不連。這包含管理員自己填的 YTS 網址和 YIFY 網址（防止有人把它指到內部服務）。判斷位址是不是內部的，用 Node 內建的 `net.BlockList`，或把範圍明白列出來並寫測試；**不要用 npm 上的 `ip` 套件**，它的 `isPublic` / `isPrivate` 有已知的誤判（GHSA-2p57-rm9w-gvfp）。
- **轉址**：最多 3 次，每次重新檢查主機和位址。YTS 不跟跨主機的轉址（[05-yts.md](05-yts.md)）。
- **逾時與大小上限**：每種請求都有。回應邊讀邊算大小，超過就中斷。
- **只用 https**。
- **記錄時去掉 query string**，只記主機和路徑。
- **字幕來源的請求先排隊**：每個來源的請求之間保持間隔，不論是哪個程式發的（[07-subtitle-providers.md](07-subtitle-providers.md) 的「共通規則」）。

這個用戶端在階段 2 做 YTS 時就要寫好，`api` 和 `media` 共用同一份。

### 開發和測試時的放寬

假的 YTS 和假的字幕來源跑在內部位址、用 `http://`，上面的規則會把它們全部擋掉。所以有一個明確的開關：

- `ALLOW_LOCAL_SOURCES=1`：允許 `http://`、允許內部位址；YTS 和 YIFY 網址的驗證也跟著放寬。
- `SOURCE_OVERRIDES`：把固定的來源主機換成別的網址（JSON，鍵是原本的主機）。用戶端在主機白名單檢查通過**之後**才換，所以白名單本身仍然有測到。
- 這兩個變數，加上 `torrent` 的 `TORRENT_TEST_PEERS`，只能出現在開發和測試的 compose 檔。**`NODE_ENV=production` 時只要設了任何一個，程式啟動時就報錯結束。** 這一點要有測試。

用環境變數而不是設定頁上的選項，是因為它不該是管理員在介面上點得到的東西。

## 上傳與壓縮檔

- 副檔名和大小先檢查，再看檔頭判斷實際格式。
- 上傳的內容永遠當成資料處理：不執行、不當成 HTML 回傳。字幕文字顯示在畫面上時一律當純文字（React 預設就是；不要用 `dangerouslySetInnerHTML`）。
- 解壓縮的限制在 [07-subtitle-providers.md](07-subtitle-providers.md)。重點是：不相信壓縮檔裡的路徑、不解出符號連結、限制數量和總大小（防壓縮炸彈）。
- 解壓工具用陣列參數啟動，不經過 shell；輸出目錄是程式自己建的工作目錄。

## 檔案路徑

- 所有檔案路徑都由資料庫裡的 id 和固定的規則組出來，**不接受請求裡的任何路徑片段**。
- 唯一來自外部的路徑是 torrent 裡的檔名和壓縮檔裡的檔名。兩者都要解析後確認落在預期的資料夾裡面。
- 匯出檔名經過檢查後只用在 `Content-Disposition` 和最終檔名，存放的資料夾是 `/data/exports/<id>/`，所以檔名不可能跳出去。
- 下載回應用 `Content-Disposition: attachment; filename*=UTF-8''<百分比編碼>`。

## 執行外部程式

ffmpeg、ffprobe、ffsubsync、解壓工具都用陣列參數啟動（`spawn(cmd, [args])`），不組字串、不經過 shell。參數裡的檔名都來自上面說的可信路徑。字幕軌的標題（「繁體中文」）是固定的字串，不是使用者輸入。

## 金鑰

| 金鑰 | 放哪裡 | 誰拿得到 |
| --- | --- | --- |
| `SECRET_KEY`、資料庫密碼、第一個管理員的密碼 | 環境變數（`.env`） | `SECRET_KEY` 只給 `api` |
| TMDB 金鑰、SubDL 金鑰、射手網 token | `secrets` 資料表，用 `SECRET_KEY` 以 AES-256-GCM 加密（每筆一個隨機的 12 位元組 nonce，名稱當作附加驗證資料） | 只有 `api` 解得開 |

- API 只回報金鑰「有沒有設定」。沒有任何端點會回傳內容。
- `.env` 不進版本控制。repo 裡只有 `.env.example`，裡面不能有真的值。
- log 裡不能出現任何金鑰，包含帶在網址裡的。寫一個測試：用假的金鑰跑一次各來源的請求，確認 log 輸出裡找不到那個字串。
- 回應裡出現的別人的金鑰，見 D28 和 [07-subtitle-providers.md](07-subtitle-providers.md)。

## 操作紀錄

使用者做的每一件有後果的事寫一列 `audit_log`。`action` 是穩定的代碼，介面上的說法由前端對照。

`target` 存的是資料，不是句子（和 API 的其他部分一樣）。「對象」那一欄怎麼顯示由前端決定，下表右欄是它需要的資料。

| 代碼 | 介面上的說法 | `target` 裡的資料 → 顯示成 |
| --- | --- | --- |
| `auth.login` | 登入 | `{os, browser}` → 裝置（「Windows · Edge」） |
| `auth.logout` | 登出 | |
| `auth.session.revoke` | 登出其他裝置 | `{os, browser}` → 裝置 |
| `auth.register` | 用邀請碼註冊 | `{code}` → 邀請碼（這時已經用掉了） |
| `auth.password.change` | 變更密碼 | |
| `auth.password.reset` | 用重設連結設定密碼 | |
| `torrent.add` | 開始下載 / 排入下載 | `{movieTitle, version}` → 片名 · 版本 |
| `torrent.join` | 加入片庫 | 同上 |
| `torrent.pause` | 暫停下載 | 同上 |
| `torrent.resume` | 繼續下載 | 同上 |
| `torrent.retry` | 重試下載 | 同上 |
| `torrent.leave` | 從片庫移除 / 放棄下載 | 同上 |
| `torrent.delete` | 刪除影片 / 取消下載 | 同上 |
| `media.preview.request` | 要求轉預覽檔 | 同上 |
| `subtitle.add` | 加入字幕 | `{movieTitle, language}` → 片名 · 語言 |
| `subtitle.remove` | 移除字幕 | 同上 |
| `subtitle.candidate.remove` | 移除候選字幕 | `{movieTitle, releaseName}` → 片名 · 版本名稱或檔名 |
| `subtitle.confirm` | 確認字幕同步 | 同上 |
| `export.create` | 匯出 MKV | `{movieTitle, fileName}` → 片名 |
| `export.delete` | 刪除匯出檔 | `{fileName}` → 檔名 |
| `admin.user.role` | 變更角色 | `{name, role}` → 名字 → 角色 |
| `admin.user.disable` | 停用帳號 | `{name}` → 名字 |
| `admin.user.enable` | 啟用帳號 | 同上 |
| `admin.user.reset_link` | 產生重設密碼連結 | 同上 |
| `admin.user.remove` | 移除帳號 | 同上 |
| `admin.invite.create` | 建立邀請 | `{role, days}` → 角色 · 有效天數。不記邀請碼：它還能用 |
| `admin.invite.revoke` | 撤銷邀請 | `{code}` → 邀請碼（這時已經作廢了） |
| `admin.storage.limit` | 變更容量上限 | `{fromBytes, toBytes}` → 舊 → 新 |
| `admin.storage.delete` | 管理員刪除 | `{itemKind, movieTitle, fileName}`（有哪個填哪個）→ 項目的種類和名稱 |
| `admin.storage.rescan` | 重新計算用量 | |
| `admin.settings.change` | 依改了哪一組設定，見下表 | `{keys}`：改到的設定鍵，用逗號連起來 |
| `admin.secret.set` | 更新金鑰 | `{name}` → 金鑰的名稱（不是內容） |
| `admin.secret.clear` | 清除金鑰 | 同上 |
| `admin.task.retry` | 重試背景工作 | `{kind, movieTitle}` → 工作的種類 · 片名 |

`torrent.leave` 和 `torrent.delete` 的差別是檔案有沒有真的被刪：還有別人持有是前者，最後一位是後者。

`admin.settings.change` 在介面上的說法依改到的鍵分組（前五種是原型用的句子）：

| 改到的鍵 | 說法 |
| --- | --- |
| `downloads.*`、`media.*` | 變更下載設定 |
| `yts.baseUrl` | 更新 YTS 網址 |
| `providers.yify.baseUrl` | 更新 YIFY Subtitles 網址 |
| `providers.justsubtitles.mode` | 變更 JustSubtitles 查詢方式 |
| `providers.cacheHours` | 變更快取時間 |
| `providers.<來源>.enabled` | 啟用字幕來源 / 停用字幕來源（對象是來源的名稱） |
| 其他（字幕庫的網址、預設語言） | 變更來源設定 |

一次儲存只寫一筆紀錄；改到好幾組時用表裡最先符合的那一種說法，`keys` 裡仍然列出全部。

這兩張表裡，下面這幾種說法是新的（原型沒有記錄那些動作，或沒有那個功能）：暫停下載、繼續下載、登出其他裝置、用重設連結設定密碼、要求轉預覽檔、移除候選字幕、重新計算用量、清除金鑰、重試背景工作、變更來源設定。其餘的都是原型用的句子。

紀錄裡不放密碼、金鑰、token、還能用的邀請碼、重設連結。

## 上線前的檢查清單

- [ ] 沒登入時，除了 `/api/health`、登入、邀請、重設相關的端點，其他都回 401
- [ ] 成員呼叫任何 `/api/admin/…` 都回 403
- [ ] 成員呼叫不是自己持有的下載、字幕、影片、匯出的端點都回 403；管理員對不是自己持有的片也一樣（匯出檔的下載與刪除、`scope=all` 的清單除外）
- [ ] `NODE_ENV=production` 時設了 `ALLOW_LOCAL_SOURCES`、`SOURCE_OVERRIDES` 或 `TORRENT_TEST_PEERS`，三個程式都拒絕啟動
- [ ] 少了 `X-Requested-With` 的寫入請求被拒絕
- [ ] 停用帳號後，他原本的 session 立刻失效
- [ ] log 和 `audit_log` 裡找不到密碼、金鑰、session 值
- [ ] JustSubtitles 回應裡帶 `api_key` 的那筆，存進資料庫的網址沒有 query string
- [ ] 管理員把 YTS 網址設成 `https://127.0.0.1` 或內部主機名稱時，請求被擋下
- [ ] 上傳一個含 `../` 路徑的 zip、一個含符號連結的 zip、一個解開超過上限的 zip，都被拒絕而且沒有在工作目錄以外留下任何檔案
- [ ] 字幕文字含 `<script>` 時，畫面上顯示的是文字
- [ ] 匯出檔名含 `/` 被拒絕
- [ ] repo 裡沒有 `.env`、沒有任何真的金鑰
