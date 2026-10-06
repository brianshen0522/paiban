# syntax=docker/dockerfile:1
#
# One image for api, torrent and media (target `server`) and one for the web app behind Caddy
# (target `proxy`). Built from deploy/docker-compose.yml:  docker compose -f deploy/docker-compose.yml build

ARG NODE_VERSION=24
ARG PNPM_VERSION=12

# ---------------------------------------------------------------- build everything
FROM node:${NODE_VERSION}-trixie-slim AS build
ARG PNPM_VERSION
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY tools/fakes/package.json tools/fakes/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY . .
RUN pnpm -r build
# A self-contained copy of the server with production dependencies only.
RUN pnpm --filter @paiban/server deploy --legacy --prod /out/server

# ---------------------------------------------------------------- api, torrent and media
FROM node:${NODE_VERSION}-trixie-slim AS server
# ffmpeg: probing, peaks, preview files, muxing.  libarchive-tools (bsdtar): zip, 7z and rar archives
# from subtitle sites; rar support has to be confirmed in the first phase (docs/16-risks.md).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 libarchive-tools ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
# ffsubsync in its own virtual environment. uv is used because a plain `pip install` failed to
# build two of its dependencies with an older system pip; a current pip inside a venv may work too.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN uv venv /opt/ffs --python /usr/bin/python3 \
 && uv pip install --python /opt/ffs/bin/python --no-cache ffsubsync==0.5.1 \
 && /opt/ffs/bin/ffsubsync --version
# Speech recognition for subtitle alignment (docs/08-media-pipeline.md, "語音辨識"). The model is
# downloaded at build time so the running service never reaches out for it.
RUN uv venv /opt/asr --python /usr/bin/python3 \
 && uv pip install --python /opt/asr/bin/python --no-cache faster-whisper==1.2.1 \
 && /opt/asr/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8', download_root='/opt/asr/models')" \
 && chmod -R a+rX /opt/asr
# IP → country for the download page's peer map: DB-IP's free "IP to Country Lite" (CC BY 4.0,
# credited on the page), this month's or last month's. Lookups then never leave the machine.
RUN <<'PY' python3
import datetime, os, sys, urllib.request
os.makedirs("/opt/geo", exist_ok=True)
first = datetime.date.today().replace(day=1)
for month in (first, (first - datetime.timedelta(days=1)).replace(day=1)):
    url = "https://download.db-ip.com/free/dbip-country-lite-%s.csv.gz" % month.strftime("%Y-%m")
    try:
        # Says honestly what is asking (the app's own name); DB-IP refuses Python's default agent.
        req = urllib.request.Request(url, headers={"User-Agent": "Paiban/0.1.0 (self-hosted; image build)"})
        with urllib.request.urlopen(req, timeout=120) as res, open("/opt/geo/dbip-country-lite.csv.gz", "wb") as out:
            out.write(res.read())
        print("geo:", url)
        break
    except Exception as err:
        print("geo: not", url, err)
else:
    sys.exit("no DB-IP country table could be downloaded")
os.chmod("/opt/geo/dbip-country-lite.csv.gz", 0o644)
PY
ENV NODE_ENV=production \
    FFSUBSYNC=/opt/ffs/bin/ffsubsync \
    FFS_PYTHON=/opt/ffs/bin/python \
    ASR_PYTHON=/opt/asr/bin/python \
    ASR_MODELS=/opt/asr/models \
    ASR_MODEL=base \
    HF_HUB_OFFLINE=1 \
    GEOIP_CSV=/opt/geo/dbip-country-lite.csv.gz
WORKDIR /app
COPY --from=build /out/server ./
# The compose file sets the numeric user; nothing in the image needs root at run time.
USER node
EXPOSE 3000
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/api.js"]

# ---------------------------------------------------------------- web app behind Caddy
FROM caddy:2 AS proxy
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
