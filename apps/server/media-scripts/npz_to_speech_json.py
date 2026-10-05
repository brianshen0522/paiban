"""Turns ffsubsync's speech cache into the JSON the browser and the sync core read.

    python npz_to_speech_json.py ref.npz speech.json

The cache holds one value per 10 ms frame (0 or 1). The JSON lists the speech as half-open
frame ranges: {"hz": 100, "frames": N, "segments": [[start, end], ...]}.
Run it with the Python that has ffsubsync installed; it only needs numpy.
"""
import json
import sys

import numpy as np

src, dst = sys.argv[1], sys.argv[2]
speech = (np.load(src)['speech'] > 0.5).astype(np.int8)
edges = np.flatnonzero(np.diff(np.concatenate([[0], speech, [0]])))
segments = [[int(a), int(b)] for a, b in zip(edges[::2], edges[1::2])]
with open(dst, 'w', encoding='utf-8') as fh:
    json.dump({'hz': 100, 'frames': int(len(speech)), 'segments': segments}, fh, separators=(',', ':'))
print(f'speech: {len(speech)} frames, {len(segments)} segments, {speech.mean() * 100:.0f}% speech', file=sys.stderr)
