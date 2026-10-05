#!/usr/bin/env bash
# Preview assets for a file the browser cannot play directly (HEVC, 10-bit, non-AAC audio).
# They are used only on the sync page; the export always uses the original file.
#
#   ./preview.sh movie.mkv /data/media/<id> 480      (or 720)
#
# Produces: audio.m4a (ready in minutes, lets people sync by ear while the video is still
# transcoding) and proxy.mp4. Each is written as *.part and renamed when complete, so a file
# with the final name is always whole.
set -euo pipefail
SRC=$1; OUT=$2; HEIGHT=${3:-480}
case "$HEIGHT" in 480) MAXRATE=600k; BUF=1200k ;; 720) MAXRATE=1500k; BUF=3000k ;; *) echo "height must be 480 or 720" >&2; exit 2 ;; esac
mkdir -p "$OUT"

# Audio first. Stereo AAC plays everywhere; copy instead (-c:a copy) when the source already is
# AAC with 1 or 2 channels at 128 kbit/s or less. A source without an audio track has no audio.m4a.
if ffprobe -v error -select_streams a:0 -show_entries stream=index -of csv=p=0 "$SRC" | grep -q .; then
  ffmpeg -v error -nostdin -y -i "$SRC" -map 0:a:0 -vn -ac 2 -c:a aac -b:a 96k -movflags +faststart -f mp4 "$OUT/audio.m4a.part"
  mv "$OUT/audio.m4a.part" "$OUT/audio.m4a"
else
  echo "no audio track: skipping audio.m4a" >&2
fi

# Video, never enlarged: a source smaller than the target keeps its own height.
# -fps_mode passthrough keeps every frame's timestamp exactly as in the source, so a time
# read from the preview is a time in the original. -maxrate caps the size, which is what makes the
# up-front space reservation safe: bytes <= (maxrate + 96 kbit/s) * duration / 8.
# 0:V:0 = the first real video stream (never cover art). 0:a:0? = the first audio track if there
# is one; a silent source still gets its preview.
ffmpeg -v error -nostdin -y -i "$SRC" -map 0:V:0 -map 0:a:0? \
  -vf "scale=-2:'min(${HEIGHT},ih)':flags=bicubic,format=yuv420p" \
  -c:v libx264 -preset veryfast -crf 28 -maxrate "$MAXRATE" -bufsize "$BUF" -fps_mode passthrough \
  -c:a aac -ac 2 -b:a 96k -movflags +faststart -f mp4 "$OUT/proxy.mp4.part"
mv "$OUT/proxy.mp4.part" "$OUT/proxy.mp4"
