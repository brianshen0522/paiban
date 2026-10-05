#!/usr/bin/env bash
# Phase 0, item 3: can the image's bsdtar read zip, 7z and rar, and what does it do with the hostile
# archives on its own? (The application enforces the limits itself; this shows what it can rely on.)
#
#   scripts/phase0/make-archives.sh && scripts/phase0/check-archives.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f deploy/docker-compose.yml run --rm --no-deps -T -v "$PWD":/work:ro -w /work media bash -s <<'EOF2'
set -uo pipefail
ref=$(mktemp -d); bsdtar -xf fixtures/archive.zip -C "$ref"
for a in fixtures/archive.zip fixtures/archives/archive.7z fixtures/archives/archive.rar; do
  out=$(mktemp -d)
  if bsdtar -xf "$a" -C "$out" 2>/tmp/err; then
    same=$(cd "$ref" && find . -type f | sort | while read -r f; do cmp -s "$f" "$out/$f" && echo ok || echo DIFF; done | sort | uniq -c | tr '\n' ' ')
    echo "READ  $a  $(bsdtar -tf "$a" | wc -l) entries, contents vs archive.zip: $same"
  else
    echo "FAIL  $a  $(cat /tmp/err)"
  fi
done
for a in fixtures/archives/hostile.*.zip fixtures/archives/nosubtitle.zip fixtures/archives/broken.zip; do
  out=$(mktemp -d)/x; mkdir -p "$out"
  bsdtar -xf "$a" -C "$out" 2>/tmp/err; code=$?
  outside=$(find /tmp -maxdepth 2 \( -name escaped.srt -o -name absolute.srt \) 2>/dev/null | wc -l)
  echo "$(basename "$a"): exit $code | stderr: $(head -c 160 /tmp/err | tr '\n' ' ') | extracted: $(cd "$out" && find . -mindepth 1 | head -3 | tr '\n' ' ')$(cd "$out" && [ "$(find . -type f | wc -l)" -gt 3 ] && echo "… ($(find . -type f | wc -l) files)") | written outside: $outside | symlinks: $(find "$out" -type l | wc -l) | bytes: $(du -sb "$out" | cut -f1)"
done
echo "listing shows sizes before extracting:"; bsdtar -tvf fixtures/archives/hostile.bomb.zip
EOF2
