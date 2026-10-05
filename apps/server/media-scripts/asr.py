"""Speech recognition on a few windows of a film, for subtitle alignment.

    asr.py <media file> <windows json> [--model base] [--language en] [--models-dir DIR]

<windows json> is a JSON list of [start, duration] pairs in seconds. Only those windows are
decoded (ffmpeg seeks to each one), so a two-hour film costs a few minutes of audio, not two
hours. Prints one JSON object on stdout:

    {"language": "en", "model": "small", "windows": [[s, d], ...],
     "segments": [{"start": 12.3, "end": 14.1, "text": "..."}, ...]}

Times are absolute (film time). Progress goes to stderr as "progress <0..1>" lines.
"""

import argparse
import json
import subprocess
import sys

import numpy as np

RATE = 16000


def window_audio(path, start, duration):
    """Mono 16 kHz float32 samples of one window, decoded by ffmpeg."""
    cmd = [
        "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
        "-ss", f"{start:.3f}", "-t", f"{duration:.3f}", "-i", path,
        "-map", "0:a:0", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "-",
    ]
    raw = subprocess.run(cmd, check=True, stdout=subprocess.PIPE).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


ENDS = tuple(".?!\u3002\uff1f\uff01\u2026")
GAP = 0.8


def sentences(words):
    """Split a recognised segment into sentences at end punctuation or a pause, using word times.

    Whisper's segments often run several lines of dialogue together; a subtitle line starts
    where its own sentence starts, so that is the time worth keeping.
    """
    out, cur = [], []
    for w in words:
        if not w.word.strip():
            continue
        if cur and w.start - cur[-1].end > GAP:
            out.append(cur)
            cur = []
        cur.append(w)
        if w.word.strip().endswith(ENDS):
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("windows")
    ap.add_argument("--model", default="base")
    ap.add_argument("--language", default=None)
    ap.add_argument("--models-dir", default=None)
    ap.add_argument("--threads", type=int, default=0)
    a = ap.parse_args()

    from faster_whisper import WhisperModel

    windows = json.loads(a.windows)
    model = WhisperModel(
        a.model, device="cpu", compute_type="int8", download_root=a.models_dir, cpu_threads=a.threads,
        local_files_only=a.models_dir is not None,
    )
    language = a.language
    out = []
    for k, (start, duration) in enumerate(windows):
        audio = window_audio(a.media, start, duration)
        if audio.size < RATE:
            continue
        segments, info = model.transcribe(
            audio,
            language=language,
            beam_size=2,
            vad_filter=True,
            condition_on_previous_text=False,
            word_timestamps=True,
        )
        for s in segments:
            for sentence in sentences(s.words or []):
                # A sentence heard from the very start of a window began before it: its start is unknown.
                if start > 0 and sentence[0].start < 0.25:
                    continue
                out.append({
                    "start": round(start + sentence[0].start, 3),
                    "end": round(start + sentence[-1].end, 3),
                    "text": "".join(w.word for w in sentence).strip(),
                })
        # The first window that clearly has speech decides the language; the rest are decoded in it.
        if language is None and info.language_probability >= 0.7:
            language = info.language
        print(f"progress {(k + 1) / len(windows):.3f}", file=sys.stderr, flush=True)

    json.dump({"language": language or "und", "model": a.model, "windows": windows, "segments": out}, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
