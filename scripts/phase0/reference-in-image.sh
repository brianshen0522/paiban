#!/usr/bin/env bash
# Phase 0, item 2 (docs/14-plan.md): run the handoff's reference tests on the image's Node, ffmpeg
# and ffsubsync rather than on the development machine. The handoff material (reference/,
# fixtures/, db/) is not in the image (.dockerignore), so the repository is mounted at /work.
#
#   scripts/phase0/reference-in-image.sh            # needs the images: docker compose -f deploy/docker-compose.yml build
#
# npm ci runs inside the container and writes node_modules into the mounted reference folders
# (same platform as the host: linux x86-64, glibc).
set -euo pipefail
cd "$(dirname "$0")/../.."

run() {
  docker compose -f deploy/docker-compose.yml run --rm --no-deps -T \
    -v "$PWD":/work -w /work -e HOME=/tmp media "$@"
}

echo "== versions"
run sh -c 'node -v; ffmpeg -version | head -1; /opt/ffs/bin/python --version; /opt/ffs/bin/ffsubsync --version; bsdtar --version'

echo "== reference/sync-core (expect 17)"
run node --test reference/sync-core/core.test.ts 2>&1 | grep -E '^ℹ (tests|pass|fail)'

echo "== reference/subtitles (expect 5)"
run sh -c 'cd reference/subtitles && npm ci --silent && npm test 2>&1' | grep -E '^ℹ (tests|pass|fail)'

echo "== db (expect 11)"
run sh -c 'cd db && npm ci --silent && npm test 2>&1' | grep -E '^ℹ (tests|pass|fail)'

echo "== reference/torrent (expect PASS)"
run sh -c 'cd reference/torrent && npm ci --silent && npm test 2>&1' | tail -3

echo "== pipeline: analyze.sh, align.ts, preview.sh, mux.sh"
run node scripts/phase0/verify-pipeline.mjs /tmp/paiban-phase0
