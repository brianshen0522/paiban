# Deployment

Installing Paiban (拍板) from scratch, routine updates, backups and moving. All commands are run from the repo's root directory.

## What you need

| Item | Requirement |
| --- | --- |
| Machine | x86-64 Linux (ARM hasn't been verified). At least 2 CPU cores; speech recognition takes about 1 to 3 minutes per film on a 2010 Xeon X5650, and much less on newer CPUs |
| Memory | 4 GB or more. Transcoding and speech recognition running at the same time use about 2 GB |
| Disk | The place for films (`DATA_PATH`) must be big enough, and all on **one file system** (finished downloads are moved there, not copied). The image itself is about 3 GB |
| Software | Docker and Compose v2 (`docker compose version` runs) |
| Network | Can reach YTS, the subtitle sources and (if configured) the language model services. Best if the BitTorrent incoming port can be opened; downloads work without it, just slower |

## First install

```bash
cp deploy/.env.example deploy/.env
openssl rand -hex 24      # paste into POSTGRES_PASSWORD
openssl rand -base64 32   # paste into SECRET_KEY
# Edit deploy/.env: PUBLIC_URL, BOOTSTRAP_ADMIN_USERNAME, BOOTSTRAP_ADMIN_PASSWORD; change the rest as needed

mkdir -p deploy/data      # must be created first, otherwise Docker creates it as root and the services can't write to it
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
docker compose -f deploy/docker-compose.yml ps    # all five containers are Up, and api is healthy
```

Open `PUBLIC_URL`, sign in with `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD`, and **go to "Profile" right away to change the password**. Afterwards you can delete those two lines from `.env` (they are only used when the users table is empty).

`deploy/.env` holds passwords and keys. Keep it out of version control (`.gitignore` already excludes it), and don't paste it anywhere.

### What to set up after signing in

"Sources" in the admin menu:

1. **YTS address**: enter a domain that currently works and press "Test". YTS changes domains often; if the Search page breaks, look here first.
2. **TMDB key** (free to get): needed for searching JustSubtitles and Assrt (Shooter).
3. **Assrt token** (if you want Chinese subtitles).
4. **Language models**: speech recognition is on by default. When the subtitles and the film are in different languages (e.g. an English film with Chinese subtitles), auto-align needs a language model, and so does subtitle translation: in "LLM settings", add a profile (OpenAI, Anthropic, Azure, OpenRouter, Ollama or a self-hosted OpenAI-compatible service), enter the key if it has one, and press "Test" to check (see [18-llm.md](18-llm.md)). Everything else works without it; subtitles in a different language can then only be aligned by speech detection, and nothing can be translated.

Take a look at concurrent downloads, speed limits and seeding in "Download settings"; set the storage limit in "Storage management".

Inviting others: "Users & invites" makes an invite link; send it to the person so they can register themselves.

## Every item in `.env`

| Variable | Required | Description |
| --- | --- | --- |
| `POSTGRES_PASSWORD` | Yes | Database password. Letters and digits only (it goes into the connection URL) |
| `SECRET_KEY` | Yes | Encrypts the keys administrators enter. If you change it later, all stored keys must be entered again |
| `PUBLIC_URL` | Yes | The address everyone types in the browser; invite and reset-password links use it. The site only accepts writes sent from this address (or the request's own host) |
| `BOOTSTRAP_ADMIN_USERNAME`, `BOOTSTRAP_ADMIN_PASSWORD` | First time | The first administrator. Created only when the users table is empty |
| `SITE_ADDRESS` | | `:80`: plain HTTP. A domain name: Caddy obtains and renews certificates itself (see HTTPS below) |
| `HTTP_PORT`, `HTTPS_PORT` | | Public ports, default 8080, 8443 |
| `DATA_PATH` | | Where on the host films, preview files, subtitles and exports go, default `./data` (relative to `deploy/`) |
| `STORAGE_LIMIT_GB` | | The **initial value** of the storage limit. Change it later in Storage management; this item isn't read again |
| `STORAGE_RESERVE_GB` | | Space always left free on the disk, default 2 |
| `TORRENT_PORT`, `TORRENT_DHT_PORT` | | BitTorrent incoming ports, default 51413 (TCP and UDP), 51414 (UDP) |
| `PUID`, `PGID` | | The user and group that own `DATA_PATH` (shown by `id`), default 1000 |
| `TZ` | | Time zone, default `Asia/Taipei` |
| `LOG_LEVEL` | | `debug`, `info`, `warn`, `error`, default `info` |
| `TMDB_KEY`, `ASSRT_TOKEN`, `SUBDL_KEY` | | Only for the scripts that check sources by hand during development. The keys the site itself uses are entered on the admin pages; these items aren't read |

## Opening ports

| Port | Protocol | For whom | Required? |
| --- | --- | --- | --- |
| `HTTP_PORT` (8080) | TCP | Users' browsers | Yes |
| `HTTPS_PORT` (8443) | TCP | Same, when using Caddy's own HTTPS | Depends on the setup |
| `TORRENT_PORT` (51413) | TCP, UDP | Other BitTorrent users | No, but much faster |
| `TORRENT_DHT_PORT` (51414) | UDP | DHT | No |

Forward these ports to this machine on the router. "Connection" in "Download settings" shows whether there were incoming connections from outside in the last 24 hours.

## Two ways to do HTTPS

**1. Let Caddy do it** (the machine faces the internet directly and has a domain name):

```
SITE_ADDRESS=films.example.net
PUBLIC_URL=https://films.example.net
HTTP_PORT=80
HTTPS_PORT=443
```

The domain's DNS must point to this machine, and 80 and 443 must be reachable from outside (for certificate validation).

**2. There is already a reverse proxy in front** (Nginx, Traefik, Cloudflare Tunnel, Synology's reverse proxy…):

```
SITE_ADDRESS=:80
PUBLIC_URL=https://films.example.net
HTTP_PORT=8080
```

The proxy in front forwards `https://films.example.net` to `http://this-machine:8080`. It must keep the `Host` header and **must not buffer responses** (live updates use server-sent events; Nginx needs `proxy_buffering off;`), and must allow 25 MB requests for subtitle uploads.

## Updating

```bash
git pull
docker compose -f deploy/docker-compose.yml build
docker compose -f deploy/docker-compose.yml up -d
```

The database structure is updated automatically when `api` starts (`apps/server/migrations/`, which only ever add). The downloader runs in its own container; downloads in progress while the site is updated continue after the restart; background jobs such as transcoding and recognition start over from the beginning.

## Backups

What needs backing up is **the database and `DATA_PATH`, both, from the same point in time**: back up only one and they won't match after a restore (files the database says exist are missing, or files on disk that nothing knows about).

```bash
cd deploy
docker compose stop torrent media                      # stop the services that write files; the site can stay up
docker compose exec -T postgres pg_dump -U paiban -Fc paiban > paiban-$(date +%F).dump
tar -C . -cf paiban-data-$(date +%F).tar data          # change this if DATA_PATH is somewhere else
docker compose start torrent media
```

The films themselves are big; if you don't want to back them up, you can back up only the database plus `data/subtitles` and `data/exports`. Afterwards, "Recount usage" in "Storage management" lists the missing files (it doesn't delete anything), and those films can be downloaded again.

### Restoring

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

## Moving to another machine

1. Make a backup on the old machine as above.
2. Install Docker on the new machine and copy the repo and `deploy/.env` over (**`SECRET_KEY` must be the same**, otherwise the keys on the admin pages must be entered again). Change `PUBLIC_URL` if it changed.
3. Follow "Restoring". The owner of `DATA_PATH` must be `PUID:PGID` (`chown -R 1000:1000 deploy/data`).
4. After signing in, go to "Storage management", press "Recount usage", and check that no files are missing.

## Checks and logs

```bash
docker compose -f deploy/docker-compose.yml ps
docker compose -f deploy/docker-compose.yml logs -f --tail=100 api      # or torrent, media, proxy
curl -s http://localhost:8080/api/health                                 # {"ok":true}
```

The administrators' "System status" page shows whether the four services are running, plus background tasks and the disk. Logs never contain passwords, keys or subtitle content.

## Common questions

| Situation | Cause and fix |
| --- | --- |
| Opening the site from another computer, signing in says "Something went wrong" | `PUBLIC_URL` differs from the address actually typed, and a proxy in between changed `Host`. Change `PUBLIC_URL` to the address people actually use |
| A service keeps restarting, and the log says permission denied | Docker created `DATA_PATH` as root. `sudo chown -R 1000:1000 deploy/data` (with your `PUID:PGID`) |
| The Search page says it can't reach YTS | YTS changed domains again. Change the address in "Sources" |
| The auto-align result says "Language model: Key rejected" | Edit the profile in "LLM settings", enter the key again and press "Test" |
| Speech recognition keeps showing in progress | On a slow CPU each film takes a few minutes, and only one film is recognized at a time; the others wait in line. `docker compose logs media` shows `speech recognised` or the reason for failure. A failure doesn't affect other features; auto-align just has one less thing to go on |
