# 部署

從零裝起拍板、日常更新、備份和搬家。所有指令都在 repo 的根目錄執行。

## 需要什麼

| 項目 | 需求 |
| --- | --- |
| 機器 | x86-64 的 Linux（ARM 還沒驗證過）。CPU 至少 2 核；語音辨識在 2010 年的 Xeon X5650 上每部片約 1 到 3 分鐘，新一點的 CPU 快很多 |
| 記憶體 | 4 GB 以上。轉檔和語音辨識同時跑時約用 2 GB |
| 磁碟 | 放電影的地方（`DATA_PATH`）要夠大，而且整個是**同一個檔案系統**（下載完成時檔案是搬過去的，不是複製）。映像檔本身約 3 GB |
| 軟體 | Docker 與 Compose v2（`docker compose version` 能執行） |
| 網路 | 能連到 YTS、字幕來源和（有設定的話）語言模型的服務。BitTorrent 的連入埠能開最好，不開也能下載，只是比較慢 |

## 第一次安裝

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24      # 貼到 POSTGRES_PASSWORD
openssl rand -base64 32   # 貼到 SECRET_KEY
# 編輯 deploy/.env：PUBLIC_URL、BOOTSTRAP_ADMIN_USERNAME、BOOTSTRAP_ADMIN_PASSWORD，其他照需要改

mkdir -p deploy/data      # 一定要先建好，否則 Docker 會用 root 建立，服務寫不進去
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps    # 五個容器都是 Up，api 是 healthy
```

打開 `PUBLIC_URL`，用 `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` 登入，**馬上到「個人設定」改密碼**。之後可以把那兩行從 `.env` 刪掉（只在使用者資料表是空的時候才會用到）。

`deploy/.env` 有密碼和金鑰，不要進版本控制（`.gitignore` 已經排除），也不要貼到任何地方。

### 登入之後要設定的

管理員選單的「來源設定」：

1. **YTS 網址**：填目前能用的網域，按「測試」。YTS 常換網域，搜尋頁壞了先來這裡看。
2. **TMDB 金鑰**（免費申請）：JustSubtitles 和射手網的搜尋需要。
3. **射手網 token**（要中文字幕的話）。
4. **自動對齊**：語音辨識預設開著。字幕和片中語言不同（例如英文片配中文字幕）時要用語言模型，選 Claude 或 OpenAI 相容的服務（通義千問、Ollama…），填金鑰，按「測試模型」確認。不設定也能用，只是不同語言的字幕只能靠人聲偵測對齊。

「下載設定」看一下同時下載數、限速和做種方式；「儲存空間管理」設定容量上限。

邀請其他人：「使用者與邀請」產生邀請連結，傳給對方自己註冊。

## `.env` 的每一項

| 變數 | 必填 | 說明 |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | 是 | 資料庫密碼。只用英數字（它會被放進連線網址） |
| `SECRET_KEY` | 是 | 加密管理員輸入的金鑰。之後改掉的話，已存的金鑰都要重新輸入 |
| `PUBLIC_URL` | 是 | 大家在瀏覽器打的網址，邀請和重設密碼的連結用它。網站只接受從這個網址（或請求本身的主機）送來的寫入 |
| `BOOTSTRAP_ADMIN_USERNAME`、`BOOTSTRAP_ADMIN_PASSWORD` | 第一次 | 第一個管理員。使用者資料表是空的時候才建立 |
| `SITE_ADDRESS` | | `:80`：純 HTTP。填網域名稱：Caddy 自己申請、更新憑證（見下面的 HTTPS） |
| `HTTP_PORT`、`HTTPS_PORT` | | 對外的埠，預設 8080、8443 |
| `DATA_PATH` | | 電影、預覽檔、字幕、匯出放在主機的哪裡，預設 `./data`（相對於 `deploy/`） |
| `STORAGE_LIMIT_GB` | | 容量上限的**初始值**。之後在儲存空間管理改，這一項不再讀 |
| `STORAGE_RESERVE_GB` | | 磁碟上永遠留下的空間，預設 2 |
| `TORRENT_PORT`、`TORRENT_DHT_PORT` | | BitTorrent 的連入埠，預設 51413（TCP 和 UDP）、51414（UDP） |
| `PUID`、`PGID` | | 擁有 `DATA_PATH` 的使用者和群組（`id` 看得到），預設 1000 |
| `TZ` | | 時區，預設 `Asia/Taipei` |
| `LOG_LEVEL` | | `debug`、`info`、`warn`、`error`，預設 `info` |
| `TMDB_KEY`、`ASSRT_TOKEN`、`SUBDL_KEY` | | 只給開發時手動檢查來源的腳本用。網站本身用的金鑰在管理頁輸入，不讀這幾項 |

## 開埠

| 埠 | 協定 | 給誰 | 必要嗎 |
| --- | --- | --- | --- |
| `HTTP_PORT`（8080） | TCP | 使用者的瀏覽器 | 是 |
| `HTTPS_PORT`（8443） | TCP | 同上，用 Caddy 自己的 HTTPS 時 | 看做法 |
| `TORRENT_PORT`（51413） | TCP、UDP | BitTorrent 的其他用戶 | 不必，但會快很多 |
| `TORRENT_DHT_PORT`（51414） | UDP | DHT | 不必 |

路由器上把這些埠轉到這台機器。「下載設定」的「連線」會顯示最近 24 小時有沒有外部連入。

## HTTPS 的兩種做法

**一、讓 Caddy 自己來**（機器直接對外、有網域名稱）：

```
SITE_ADDRESS=films.example.net
PUBLIC_URL=https://films.example.net
HTTP_PORT=80
HTTPS_PORT=443
```

網域的 DNS 要指到這台機器，80 和 443 要能從外面連到（憑證的驗證用）。

**二、前面已經有反向代理**（Nginx、Traefik、Cloudflare Tunnel、群暉的反向代理…）：

```
SITE_ADDRESS=:80
PUBLIC_URL=https://films.example.net
HTTP_PORT=8080
```

前面的代理把 `https://films.example.net` 轉到 `http://這台機器:8080`。要保留 `Host` 標頭，而且**不要緩衝回應**（即時更新用的是 server-sent events；Nginx 要 `proxy_buffering off;`），上傳字幕要允許 25 MB 的請求。

## 更新

```bash
git pull
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
```

資料庫的結構在 `api` 啟動時自動更新（`apps/server/migrations/`，只會往前加）。下載程式在自己的容器裡，更新網站時進行中的下載會在重啟後接著下載；轉檔、辨識之類的背景工作會從頭再做一次。

## 備份

要備份的是**資料庫和 `DATA_PATH` 兩樣，而且要同一個時間點**：只備其中一樣，還原後會對不起來（資料庫說有的檔案不在，或磁碟上的檔案沒人認得）。

```bash
cd deploy
docker compose stop torrent media                      # 停住會寫檔的服務，網站可以繼續開著
docker compose exec -T postgres pg_dump -U paiban -Fc paiban > paiban-$(date +%F).dump
tar -C . -cf paiban-data-$(date +%F).tar data          # DATA_PATH 是別的地方的話改這裡
docker compose start torrent media
```

電影本身很大；不想備份電影的話，可以只備份資料庫加 `data/subtitles`、`data/exports`。之後用「儲存空間管理」的「重新計算」，系統會列出缺少的檔案（不會刪任何東西），那些電影再下載一次。

### 還原

```bash
cd deploy
docker compose down
tar -C . -xf paiban-data-2026-10-06.tar
docker compose up -d postgres
docker compose exec -T postgres dropdb -U paiban paiban
docker compose exec -T postgres createdb -U paiban paiban
docker compose exec -T postgres pg_restore -U paiban -d paiban < paiban-2026-10-06.dump
docker compose up -d
```

## 搬到另一台機器

1. 在舊機器做一次上面的備份。
2. 新機器裝好 Docker，把 repo 和 `deploy/.env` 複製過去（**`SECRET_KEY` 要一樣**，不然管理頁的金鑰要重新輸入）。`PUBLIC_URL` 變了就改。
3. 照「還原」做。`DATA_PATH` 的擁有者要是 `PUID:PGID`（`chown -R 1000:1000 deploy/data`）。
4. 登入後到「儲存空間管理」按「重新計算」，確認沒有缺少的檔案。

## 檢查和記錄

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f --tail=100 api      # 或 torrent、media、proxy
curl -s http://localhost:8080/api/health                                 # {"ok":true}
```

管理員的「系統狀態」頁顯示四個服務是否在運作、背景任務和磁碟。記錄裡不會有密碼、金鑰或字幕內容。

## 常見問題

| 狀況 | 原因和做法 |
| --- | --- |
| 從別台電腦打開網站，登入時說「發生錯誤」 | `PUBLIC_URL` 和實際打的網址不同，而且中間有代理改了 `Host`。把 `PUBLIC_URL` 改成大家實際用的網址 |
| 服務一直重啟，記錄說 permission denied | `DATA_PATH` 被 Docker 用 root 建立了。`sudo chown -R 1000:1000 deploy/data`（換成你的 `PUID:PGID`） |
| 搜尋頁說 YTS 連不上 | YTS 又換網域了。到「來源設定」改網址 |
| 自動對齊結果寫「語言模型：金鑰被拒絕」 | 到「來源設定」的「自動對齊」重新輸入金鑰，按「測試模型」 |
| 語音辨識一直顯示進行中 | 慢的 CPU 上每部片要幾分鐘，一次只辨識一部，其他片子排在後面。`docker compose logs media` 看得到 `speech recognised` 或失敗的原因。失敗不影響其他功能，只是自動對齊少一個依據 |
