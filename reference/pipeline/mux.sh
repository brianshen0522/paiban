#!/usr/bin/env bash
# Export: the original video and audio, untouched, plus the confirmed subtitles as soft tracks.
#
#   TITLE="Sample Movie (2020)" ./mux.sh movie.mp4 out.mkv  zh.srt chi "繁體中文"  en.srt eng "English"
#
# Subtitle arguments come in threes: file, ISO 639-2 language, track title. The first one is the
# default track. Every subtitle file must already be UTF-8: with -c copy ffmpeg does not look
# inside, and a Big5 file would be muxed as garbage without any error.
set -euo pipefail
SRC=$1; DST=$2; shift 2
inputs=(-i "$SRC"); meta=(); n=0
# 0:V = real video streams only. Lower-case 0:v would also take cover art and turn it into a
# second video track. 0:a? = every audio track, and no error when the source has none.
# Subtitle and data tracks of the source are left behind on purpose.
maps=(-map 0:V -map "0:a?")
while (($#)); do
  inputs+=(-i "$1"); maps+=(-map "$((n + 1)):0")
  meta+=("-metadata:s:s:$n" "language=$2" "-metadata:s:s:$n" "title=$3" "-disposition:s:$n" "$([ $n -eq 0 ] && echo default || echo 0)")
  shift 3; n=$((n + 1))
done
# The container title of downloaded files is often an advertisement; replace it.
[ -n "${TITLE:-}" ] && meta+=(-metadata "title=$TITLE")
# -c copy: nothing is re-encoded. -progress prints out_time_us=<microseconds> lines for a progress bar.
ffmpeg -v error -nostdin -y -progress pipe:1 -nostats "${inputs[@]}" "${maps[@]}" -c copy "${meta[@]}" -f matroska "$DST.part" > /dev/null
mv "$DST.part" "$DST"
