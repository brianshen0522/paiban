#!/usr/bin/env bash
# What the media worker does once a download completes. Everything is written to OUT_DIR;
# the downloaded file is only read.
#
#   FFSUBSYNC=/opt/ffs/bin/ffsubsync FFS_PYTHON=/opt/ffs/bin/python ./analyze.sh movie.mp4 /data/media/<id>
#
# Produces: probe.json  peaks.bin  ref.npz  speech.json
set -euo pipefail
SRC=$(realpath "$1"); OUT=$2
FFSUBSYNC=${FFSUBSYNC:-ffsubsync}; FFS_PYTHON=${FFS_PYTHON:-${PYTHON:-python3}}
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$OUT"
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT          # in the app: /data/tmp/work/<job id>

# 1. Container and stream facts: duration, codecs, pixel format, frame rate, channels.
ffprobe -v error -show_format -show_streams -of json "$SRC" > "$OUT/probe.json"

# 2. Waveform peaks from the first audio track.
ffmpeg -v error -nostdin -i "$SRC" -map 0:a:0 -vn -ac 1 -ar 8000 -f s16le - | node "$HERE/peaks.mjs" 50 "$OUT/peaks.bin"

# 3. Speech detection. ffsubsync writes <reference path without extension>.npz next to the
#    reference, so point it at a symlink in the scratch folder: nothing lands in the download
#    folder, and the only thing ever removed is the job's own scratch.
#    --vad webrtc matters: the default (subs_then_webrtc) uses an embedded subtitle track's
#    cue times instead of the audio whenever the file has one.
ln -s "$SRC" "$WORK/ref.${SRC##*.}"
"$FFSUBSYNC" "$WORK/ref.${SRC##*.}" --serialize-speech --vad webrtc < /dev/null 2> "$WORK/ffsubsync.log" \
  || { cat "$WORK/ffsubsync.log" >&2; exit 1; }
mv "$WORK/ref.npz" "$OUT/ref.npz"

# 4. The same speech as JSON for the browser and the sync core.
"$FFS_PYTHON" "$HERE/npz_to_speech_json.py" "$OUT/ref.npz" "$OUT/speech.json"
