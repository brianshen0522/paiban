#!/usr/bin/env bash
# Runs the server tests inside the built image, where ffmpeg and ffsubsync are (the media tests
# need them; on a machine without them they are skipped). Uses the host's test database and the
# repository's node_modules (same platform: linux x86-64, glibc).
#
#   pnpm db:test && docker compose -f deploy/docker-compose.yml build && pnpm test:image [vitest args]
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm --network host -v "$PWD":/work -w /work/apps/server -e HOME=/tmp \
  -e TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgres://paiban:paiban-test-not-real@127.0.0.1:55432/postgres}" \
  --entrypoint ./node_modules/.bin/vitest paiban-server:latest run "$@"
