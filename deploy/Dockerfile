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
ENV NODE_ENV=production \
    FFSUBSYNC=/opt/ffs/bin/ffsubsync \
    FFS_PYTHON=/opt/ffs/bin/python \
    ASR_PYTHON=/opt/asr/bin/python \
    ASR_MODELS=/opt/asr/models \
    ASR_MODEL=base \
    HF_HUB_OFFLINE=1
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
