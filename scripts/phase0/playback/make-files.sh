#!/usr/bin/env bash
# Phase 0, item 7: files shaped like YTS releases, made from the open film Tears of Steel.
#   yts-like.stereo.mp4  H.264 High, yuv420p 8-bit, AAC-LC stereo, moov at the END (no faststart)
#   yts-like.5.1.mp4     same video (stream copy), AAC-LC 5.1, moov at the end
# Written to .scratch/playback/. Needs the film from real-swarm.mjs --film tears-of-steel.
set -euo pipefail
cd "$(dirname "$0")/../../.."
mkdir -p .scratch/playback
docker compose -f deploy/docker-compose.yml run --rm --no-deps -T -v "$PWD":/work -w /work media bash -s <<'EOF2'
set -euo pipefail
SRC="/work/.scratch/tears-of-steel/Tears of Steel/Tears of Steel.webm"; OUT=/work/.scratch/playback
ffmpeg -v error -nostdin -y -i "$SRC" -map 0:v:0 -map 0:a:0 \
  -c:v libx264 -profile:v high -preset veryfast -crf 23 -pix_fmt yuv420p -vf scale=1280:-2 \
  -c:a aac -b:a 128k -ac 2 "$OUT/yts-like.stereo.mp4"
ffmpeg -v error -nostdin -y -i "$OUT/yts-like.stereo.mp4" -i "$SRC" -map 0:v:0 -map 1:a:0 \
  -c:v copy -c:a aac -b:a 384k -ac 6 "$OUT/yts-like.5.1.mp4"
for f in "$OUT"/yts-like.*.mp4; do
  echo "$(basename "$f"): $(ffprobe -v error -show_entries stream=codec_name,profile,pix_fmt,channels -of csv=p=0 "$f" | tr '\n' ' ')"
  # Where is the moov atom? Print the top-level box order.
  python3 - "$f" <<'PY'
import struct, sys
f = open(sys.argv[1], 'rb'); order = []
while True:
    h = f.read(8)
    if len(h) < 8: break
    size, kind = struct.unpack('>I4s', h)
    if size == 1: size = struct.unpack('>Q', f.read(8))[0]; f.seek(size - 16, 1)
    else: f.seek(size - 8, 1)
    order.append(kind.decode())
print('  top-level boxes:', ' '.join(order))
PY
done
EOF2
