#!/usr/bin/env bash
# Phase 0, item 6: analyse a real open film in the image and measure auto-align on its official
# English subtitle (scripts/phase0/real-film-align.ts). Needs the film from real-swarm.mjs.
#
#   scripts/phase0/real-film.sh "Tears of Steel/Tears of Steel.webm" "Tears of Steel/Tears of Steel.en.srt" tears-of-steel
#   scripts/phase0/real-film.sh "Sintel/Sintel.mp4" "Sintel/Sintel.en.srt" sintel
#
# Paths are relative to .scratch/<name>/ (the download folder). Results go to .scratch/<name>/analysis
# and .scratch/<name>/align.json.
set -euo pipefail
cd "$(dirname "$0")/../.."
VIDEO=$1; SRT=$2; NAME=$3
docker compose -f deploy/docker-compose.yml run --rm --no-deps -T -v "$PWD":/work -w /work -e HOME=/tmp media bash -s "$VIDEO" "$SRT" "$NAME" <<'EOF2'
set -euo pipefail
VIDEO=$1; SRT=$2; NAME=$3; D=/work/.scratch/$NAME
export FFSUBSYNC=/opt/ffs/bin/ffsubsync FFS_PYTHON=/opt/ffs/bin/python
echo "duration: $(ffprobe -v error -show_entries format=duration -of csv=p=0 "$D/$VIDEO") s, nproc: $(nproc)"
start=$(date +%s.%N)
bash reference/pipeline/analyze.sh "$D/$VIDEO" "$D/analysis"
echo "analyze.sh took $(echo "$(date +%s.%N) - $start" | bc 2>/dev/null || python3 -c "import time;print(round(time.time()-$start,1))") s"
node scripts/phase0/real-film-align.ts "$D/analysis" "$D/$SRT" > "$D/align.json"
echo "written $D/align.json"
EOF2
