# 08 Video processing (media)

The `media` program runs every background job that uses ffmpeg and ffsubsync. Every command in this document has actually been run on ffmpeg 6.1.1 and ffsubsync 0.5.1; runnable versions are in `reference/pipeline/`.

## After a film finishes downloading

```mermaid
flowchart TD
  A[Download finished] --> P[First step of media.analyze<br/>probe: duration, codecs, direct play or not]
  P --> W[media.analyze continues<br/>waveform, speech]
  P -->|no direct play| C[media.preview<br/>audio.m4a first, then proxy.mp4]
  W --> R1[Waveform, score, snap, auto-align available]
  C --> R2[audio.m4a ready: can sync in audio-only mode]
  C --> R3[proxy.mp4 ready: can sync while watching the picture]
```

After `torrent` creates the `media_files` row it sends `NOTIFY paiban_media`. The reconciliation step in `media` sees the row and queues jobs for it (rules under "Reconciliation" below). Every finished file is probed first; preview assets do not wait for the waveform and speech data, and transcoding can start as soon as probing is done.

## Measured numbers

A 2-core sandbox, a 2-hour synthetic video (mono AAC, 640×360). Real 1080p video takes about as long in the analysis steps, because only the audio is decoded.

| Job | Time | Output size |
| --- | --- | --- |
| Waveform (`peaks.bin`) | 12 s | 720 KB (310 KB gzipped) |
| Speech detection (`ref.npz`) | 23 to 27 s | 18 KB |
| Audio file, stream copy | 4 s | Same size as the original audio track |
| Audio file, transcoded to stereo AAC 96 kbps | 3 min 43 s | 81 MB |
| Preview file 480p (source is 1080p 10-bit HEVC, 5.1 channels) | 3.1× real time | 2.6 MB per minute |
| Preview file 720p (same source) | 2.4× real time | 5.3 MB per minute |
| Auto-align one subtitle track (speech already cached) | ffsubsync, two runs, 0.7 s total; sync core 0.08 s for 26 lines, 0.4 s for 180 lines (1,500 lines estimated at about 3 s, not measured) | |
| Pack the MKV | Depends on disk speed; 0.1 s for a 92-second clip | About the same as the original file |

Preview speed was measured on 60-second clips. **A 2160p source is much slower, and on a NAS-class CPU may be slower than real time**, which is exactly why "audio-only mode" is needed.

## Analysis (`media.analyze`)

The input is one `media_files` row. Reference: `reference/pipeline/analyze.sh`. One job, two parts:

- **Probe**: runs when `probe_state` is `pending`. Done once for every file, in under a second. It decides whether the file can be played directly, how long it is, and whether the plan for preview assets needs correcting.
- **Waveform and speech**: runs only when probing succeeded and `analysis_state` is `pending`. When automatic analysis is off (`media.analyzeAuto`), it is `none` after the download finishes, and this part waits until someone opens the film's workspace and the frontend calls `POST /api/media/:id/analyze`.

Each part has its own state, is claimed on its own (`pending` → `running`) and finishes on its own. `POST /api/media/:id/analyze` sets an `analysis_state` of `none` or `failed` to `pending`; when `probe_state` is `failed`, it also sets that back to `pending` to probe again.

### 1. Probe

```bash
ffprobe -v error -show_format -show_streams -of json "$SRC" > probe.json
```

Written back to `media_files`: duration, container, video codec, pixel format, width and height, frame rate, audio codec, channel count.

**Whether it can be played directly** is settled here, replacing the prediction made before the download:

```
direct_play =
     container is MP4
     && video is h264 with pixel format yuv420p (8-bit 4:2:0)
     && (no audio track || first audio track is aac or mp3)
  || container is WebM
     && video is vp8, vp9 or av1 with pixel format yuv420p
     && (no audio track || first audio track is opus or vorbis)
```

- For MP4, ffprobe returns a `format_name` of `mov,mp4,m4a,3gp,3g2,mj2`. For MKV and WebM it returns the same value (`matroska,webm`), so for WebM the file extension must also be `.webm`. MKV never counts as directly playable.
- The WebM rule is mainly for testing: the end-to-end tests use `fixtures/clip.webm`, so they do not depend on whether the test browser can decode H.264 (the Playwright Chromium at handover could not; Playwright 1.63, used in Phase 0, can; see 15-testing.md). YTS does not release WebM, so production almost never sees it.
- The check is written as one function, so later adjustments (for example, some browsers cannot play 5.1-channel AAC) change only one place.

When the prediction and the result differ:

| Predicted | Actual | Handling |
| --- | --- | --- |
| Not playable | Playable | `audio_state` and `proxy_state` become `none`, `reserve_bytes` is set to zero |
| Playable | Not playable | Nothing was reserved and there was no preview plan, so compute it from the **current** settings. In a transaction, `storage_admit(preview reservation)`: if admitted, set `audio_state` (and `proxy_state`, if automatic transcoding is on) to `pending` and write the reserved amount; if not, keep `none` and record `PREVIEW_NO_SPACE` in `error.proxy`. The workbench explains "There was not enough space when the download finished, so no preview file was made." and offers a "Make preview file" button |

Once the actual duration is known, recompute the reservation with it (before the download, the YTS duration was used, which may be 0):

- Smaller: just reduce it.
- Larger: run the difference through admission again. If admitted, raise it. If not, **give up the preview video**: `proxy_state = 'none'`, record `PREVIEW_NO_SPACE` in `error`, and reduce the reservation to just the audio file's amount; the audio file is still made. The audio file is small, so it is not checked separately here, for the same reason as "Small files" in [10-storage.md](10-storage.md).

Special cases:

| Case | Handling |
| --- | --- |
| No audio track | Neither waveform nor speech can be made: `analysis_state = 'failed'`, `error.analysis` records `NO_AUDIO`. The audio file is not made (`audio_state = 'none'`, that part of the reservation is released). The preview video is still made, just without sound. The film can still be opened in a workspace, just without waveform, score or auto-align |
| ffprobe cannot read the file | `probe_state = 'failed'`, `error.analysis` records `PROBE_FAILED`. Pending analysis is also marked `failed`; preview assets are given up (`none`, reservation released). The file is most likely broken, and the interface must show this reason. It is not retried automatically; only when someone presses "Analyze again" or "Make preview file" |

Probe succeeded: `probe_state = 'ready'`, the other fields are written to the database, and `NOTIFY paiban_media` (preview assets can now be queued) and `paiban_events` (`torrent`; plus `usage` if the reservation changed).

### 1b. Subtitles from the torrent (Brian, 2026-10-09)

After a successful probe (whatever the result; the probe itself never fails because of this step), add the subtitles that came with the download as subtitles of this film:

- **Files alongside**: `.srt`, `.ass`, `.ssa`, `.vtt` under `/data/torrents/<hash>/` (up to four levels deep), regular files only (symbolic links are not followed), at most 5 MB each, at most 50, sorted by path. The displayed name is the path inside the torrent folder (`Subs/English.srt`).
- **Subtitle tracks inside the video**: streams in the ffprobe result with `codec_type = subtitle` and a text codec (`subrip`, `ass`, `ssa`, `webvtt`, `mov_text`, `text`), at most 20 tracks. All are written out in one `ffmpeg -nostdin -v error -y -i <video> -map 0:<n> -c:s srt|ass <work>/track-<n>.srt|ass …` (`nice`), into `tmp/work/bundled-<media id>/`, and that work folder is deleted afterwards. The displayed name is "〈video file name〉 #〈track number〉 (〈language tag〉 · 〈track title〉)". Image-based subtitles (PGS, VobSub) cannot be converted to text and are skipped.
- Each one is written the same way as "Adding" ([07-subtitle-providers.md](07-subtitle-providers.md)): decode, detect format and language (when the language cannot be detected, use the subtitle track's language tag), `provider = 'bundled'`, `provider_ref` is `file:<path>` or `track:<track number>`, status not yet confirmed, `added_by` empty (not added by any person). Simplified Chinese is converted according to the download initiator's "convert Simplified to Traditional automatically" preference (the original lines are kept in `cues.original.json`). The sync doc is the default (no offset), with checkpoints attached.
- If the content is the same as a subtitle this film already has (`sha256`), it is skipped, so analyzing again does not add it twice. If the download is being deleted, nothing is added.
- For each one added, `NOTIFY paiban_events` (`{type: 'subtitle', id}`), and `api` pushes it to the holders; usage is pushed once at the end.
- Same for YTS downloads and downloads added by hand. A torrent added by hand normally downloads only the largest video file; the subtitle files alongside it are selected for download too ([06-torrent-worker.md](06-torrent-worker.md) "Adding by hand").

### 2. Waveform

```bash
ffmpeg -v error -nostdin -i "$SRC" -map 0:a:0 -vn -ac 1 -ar 8000 -f s16le - \
  | node peaks.mjs 50 peaks.bin
```

The `peaks.bin` format: signed 8-bit integers in pairs (minimum, maximum), 50 pairs per second. Pair p covers `[p/50, (p+1)/50)` seconds. The browser fetches the whole thing and uses it as an `Int8Array`. The program that makes it is `reference/pipeline/peaks.mjs`; the production version puts the same logic in `media` and reads ffmpeg's stdout directly.

### 3. Speech detection

```bash
ln -s "$SRC" "$WORK/ref.mp4"                 # $WORK is this job's own temp folder
ffsubsync "$WORK/ref.mp4" --serialize-speech --vad webrtc < /dev/null
mv "$WORK/ref.npz" "$OUT/ref.npz"            # $OUT is /data/media/<id>
```

Three details that must be followed, all found by testing:

- **`--vad webrtc` must not be left out.** The default is `subs_then_webrtc`: if the video file has an embedded subtitle track, ffsubsync uses that subtitle's timing as "speech" instead of analyzing the audio. Tested with a file that had a wrong subtitle embedded, 46% of frames differed from the real speech.
- **The output location is determined by the reference file's path**: it writes to "reference file path without the extension + `.npz`". So create a symbolic link in the job's temp folder pointing to the original file and use the link as the reference file; the cache lands in the temp folder and is then moved to the output folder. The download folder stays untouched; the only thing that gets cleaned up is this job's own temp files. The link must have the same extension as the original file.
- **It runs without a subtitle**: with no `-i` and stdin connected to `/dev/null`, it exits after speech detection.

`ref.npz` contains an array called `speech`, one value (0 or 1) every 10 milliseconds. Later alignments use this file as the reference, so the audio does not need to be analyzed again.

### 4. Speech data for the browser

```bash
python npz_to_speech_json.py ref.npz speech.json
```

`{"hz": 100, "frames": N, "segments": [[start frame, end frame), …]}`. This is the API's `SpeechData`, and also the input to the sync core.

### End of analysis

| Result | State |
| --- | --- |
| Both waveform and speech were made | `analysis_state = 'ready'` |
| One of them could not be made (both attempts failed) | `analysis_state = 'failed'`, `error` records `PEAKS_FAILED` or `SPEECH_FAILED` |

On failure, whichever file was made is kept and used: with a waveform but no speech, the workbench has the waveform but no score, snap or auto-align. The two endpoints (`peaks`, `speech`) each check whether their file exists.

Write `analysis_bytes`, `NOTIFY` (`torrent`, `usage`). "Analyzing" on screen becomes "Done". The "download finished" notification is not sent here: `torrent` sent it the moment the download finished, whether or not analysis succeeds.

## Preview assets (`media.preview`)

Made only for versions that cannot be played directly. One job does two things in order, each depending on that row's state:

1. `audio_state = 'pending'`: make the audio file `audio.m4a`.
2. `proxy_state = 'pending'`: make the preview video `proxy.mp4` at resolution `proxy_res`.

The audio file comes first because it is fast: while the video is still transcoding, the user can already sync subtitles by listening to the sound and looking at the waveform ("audio-only mode"). As each one finishes, write its actual size, recompute `reserve_bytes`, and `NOTIFY` (`torrent`, `usage`), without waiting for the other.

Reference: `reference/pipeline/preview.sh`.

### Audio file

| Source's first audio track | Approach |
| --- | --- |
| AAC, 1 or 2 channels, bitrate no more than 128 kbps | Stream copy (a few seconds) |
| Anything else (5.1, other codecs) | Transcode to stereo AAC 96 kbps (about 4 minutes for a 2-hour film) |
| No audio track | Not made (probing already set `audio_state` to `none`) |

```bash
# When transcoding is needed
ffmpeg -v error -nostdin -y -i "$SRC" -map 0:a:0 -vn -ac 2 -c:a aac -b:a 96k \
  -movflags +faststart -f mp4 audio.m4a.part && mv audio.m4a.part audio.m4a
```

### Preview video

```bash
ffmpeg -v error -nostdin -y -progress pipe:1 -nostats -i "$SRC" -map 0:V:0 -map 0:a:0? \
  -vf "scale=-2:'min(480,ih)':flags=bicubic,format=yuv420p" \
  -c:v libx264 -preset veryfast -crf 28 -maxrate 600k -bufsize 1200k -fps_mode passthrough \
  -c:a aac -ac 2 -b:a 96k -movflags +faststart -f mp4 proxy.mp4.part && mv proxy.mp4.part proxy.mp4
```

For 720p: `min(720,ih)`, `-maxrate 1500k -bufsize 3000k`.

- **`-fps_mode passthrough` is the key.** It keeps every frame's timestamp exactly the same as in the original. Measured: for a list of 1,439 frame timestamps, the hashes of the original and the preview file were identical. So a time synced on the preview file is the original file's time.
- **`-maxrate` caps the size.** The file never exceeds "(video cap + 96 kbps audio) × duration", which is the basis for the space reserved before the download (numbers in [10-storage.md](10-storage.md)). After completion the actual size is recorded instead, usually only half of the cap.
- **`min(480,ih)`: no upscaling.** When the source is smaller than the target, it keeps its original height.
- **`0:V:0` (uppercase)** is the first real video track and never picks cover art. The question mark in **`0:a:0?`** means "use it if present": when the source has no audio track, the preview video is still made, just without sound.
- Progress: `-progress pipe:1` outputs `out_time_us=<microseconds>`; divided by the duration, that is the progress, written to `proxy_progress` every 2 seconds.
- Run with `nice -n 10`, so the website and downloads take priority.

### Done, failed, deleted

- The update that sets the state to `ready` must be conditional (`where … = 'running'`). If it updates nothing, the asset was deleted by someone during transcoding: delete the file that was just renamed (it is this job's own output) and finish.
- Failure (after both attempts fail): delete the `.part`, set that asset's state to `failed`, record `TRANSCODE_FAILED` in `error`, and release its reservation. The two assets do not affect each other: if the preview video fails, the audio file is still used and the user can still use audio-only mode.
- An administrator deletes the preview file ([10-storage.md](10-storage.md)): `api` sets both states to `none`, sets size and reservation to zero, and deletes the files. A job that is transcoding finds at its next check (within 2 seconds) that its asset is no longer `running`, kills ffmpeg, deletes its own `.part` and finishes.

### Requesting later

`POST /api/media/:id/proxy`: the user presses "Make preview file" in the workbench (after automatic transcoding was off, there was not enough space earlier, it failed, or an administrator deleted it). It sets whichever of the audio file and preview video is `none` or `failed` to `pending`, uses the current setting for the preview video's resolution, and runs the two reservations together through admission once. If admitted, it clears `error` and sends `NOTIFY paiban_media`. For a file whose probe failed (`probe_state` is `failed`), it also sets `probe_state` back to `pending`: preview assets start only after a successful probe, and without this they would stay waiting forever. The space needed is in `MediaStatus.previewNeedBytes` and must be shown next to the button.

## Auto-align

Input: the line list of a subtitle or candidate, plus this film's `ref.npz` and `speech.json`. Output: `AlignResult`. A runnable reference implementation is `reference/pipeline/align.ts`.

The same computation is used in two places:

| Queue | When | Where the result goes |
| --- | --- | --- |
| `subtitle.align` | The user presses "Auto-align" in the workbench. They are waiting | Written to `tasks.result`, returned to the browser by `api` |
| `subtitle.rank` | "Auto-align and rank all", one job per candidate | Written back to that candidate's `align_score` and `align_result` |

There are two queues so that the one the user pressed does not wait behind thirty candidates.

### Why two methods

| Method | Strengths | Weaknesses |
| --- | --- | --- |
| ffsubsync | Used by many people on real video; split mode can find multiple breakpoints | In split mode, when subtitles stay on longer than the dialogue, the whole result is about 0.3 seconds early (measured); results are printed to only three decimal places |
| Sync core (`autoAlign` in `packages/shared`) | Same scoring as the workbench; within 60 milliseconds in all three scenarios on synthetic material | Finds only one breakpoint; cannot find offsets outside the search range; not verified on real video |

Both have been tested only on synthetic speech. Having each compute a result, comparing them with the same yardstick, and telling the user whether they agree is the best confidence indicator available for now.

### Steps

```
1. Write a temporary SRT: times as they are, text replaced with "#<line number>".
   (ffsubsync needs only the times; this way the output can be matched back by number, and the subtitle text never enters its log.)

2. ffsubsync ref.npz -i in.srt -o linear.srt --max-offset-seconds 60
   → least squares on "input start time → output start time" gives rate and offset   fitLinearSegment
   → if the rate is within 0.002 of a known ratio, take that ratio                     snapScale
   → re-align the offset against speech within ±1.5 seconds                            refineSegments

3. When splitting is allowed:
   ffsubsync ref.npz -i in.srt -o split.srt --max-offset-seconds 60 --split-penalty
   → median slope between adjacent lines as the rate; lines with similar offsets form a segment   fitPiecewise
   → each segment is re-aligned on its own                                             refineSegments

4. Sync core: autoAlign(speech, cues, { allowSplit, radius: 60 })

5. Score every candidate with the same objective function, minus 3 seconds of dialogue per extra segment;   pickAlignment
   when within 0.3 seconds of dialogue, take the one with fewer segments, then the more common rate.

6. agree = in the other method's result, every line's start time is within 0.15 seconds of the chosen one.
```

The names on the right are the corresponding functions in `packages/shared/src/sync-core/core.ts`, all tested.

If any ffsubsync run fails (non-zero exit code, no output, output line count does not match, more than 20 seconds), that candidate is skipped; as long as one candidate remains, the result is returned as usual. The job fails only when both methods fail. ffsubsync normally takes under 1 second, so 20 seconds is generous; the sync core's time is predictable (see "Performance"), so it has no separate timeout.

### How the result gets back to `api`

`POST /api/subtitles/:id/auto-align` waits for the result before responding, but the computation runs in another program:

1. `api` creates a `tasks` row (kind `align`, `input` is the subtitle id and `allowSplit`), queues it on `subtitle.align`, then waits on `paiban_events` for this job's notification (`{type: 'task', id}`).
2. `media` finishes, writes the `AlignResult` to `tasks.result`, sets `state` to `done` (or `failed`), and sends `NOTIFY`.
3. `api` reads the result and returns it to the browser. If the job is `failed`, or no notification arrives within 60 seconds, it returns `ALIGN_FAILED`. When it times out, `api` marks that `tasks` row `failed` (`TIMEOUT`); even if `media` finishes later, its conditional update changes nothing and the result is discarded.

This job is not retried automatically: the user just presses again. `tasks.input` holds only the id and options; `media` reads the line list itself from `cues.json`.

### Results on the test fixtures

The 92-second clip in `fixtures/`, with three deliberately wrong subtitle files (26 lines):

| Scenario | ffsubsync single offset | ffsubsync split (raw) | Split, then re-aligned | Sync core | Final choice |
| --- | --- | --- | --- | --- | --- |
| 2.4 seconds late overall | Max error 54 ms | 250 ms (all early) | 40 ms | 40 ms | One segment, ×1, −2.36 s |
| Different frame rate (25 → 23.976) | 50 ms | 247 ms | 43 ms | 44 ms | One segment, ×1.04271, −0.79 s |
| Different cut (12 seconds apart in the middle) | 12 s (a single offset cannot fit) | 254 ms, two segments | 48 ms | 50 ms | Two segments, +1.25 / +13.24 s |

Both methods agree in all three scenarios (`agree = true`). The raw numbers for the first two columns are in `fixtures/expected.ffsubsync.json`, and ffsubsync's output files are in `fixtures/ffsubsync/`, so the parsing and comparison code can be unit-tested without installing ffsubsync.

What `reference/pipeline/align.ts` prints is the last column (segments, rate, offset) plus the score and `agree`, not each method's error. When using it to verify an environment, compare against the last column: same number of segments and same rate, offsets within 0.01 seconds, `agree` is true. The errors in the middle columns are what `packages/shared/src/sync-core/core.test.ts` tests.

`fixtures/film/film.json` is a 21.5-minute synthetic film (180 lines). The sync core puts all 180 lines within 100 milliseconds in all three scenarios; in the different-cut scenario the gap is 40 seconds, which is not found with a 30-second search range and is found with 60 seconds. So the range is set to 60 seconds, the same as ffsubsync's default maximum.

**The 92-second clip is too short to tell close rates apart** (for example ×0.999 and ×1): they differ by only 0.09 seconds at the end of the clip. At real film length the difference is several seconds, so they are not confused. The tests resolve this tie with "common rates first".

### Performance

The sync core's cost is "number of rates × number of lines × number of offset steps". 1,500 lines, a 60-second range, 10-millisecond resolution and 7 rates is about 130 million lookups, estimated at 3 seconds; when splitting is allowed, each rate keeps a "lines × offset steps" table, about 72 MB. That is acceptable on the server. If it needs to be faster, first search coarsely at 40-millisecond resolution, then finely at 10 milliseconds around the best position.

**The browser does not run whole-film `autoAlign`.** The browser uses only `bestLinear` (snap, 1.5-second range), `fitAnchors`, `applyDoc` and the score, all at the millisecond level.

### Sync score

`totalScore`: across the time all lines are displayed, the share that falls on detected speech, from 0 to 1.

- **Even accurately synced subtitles never reach 100%.** The correct subtitles for the test clip score 80%, because subtitles appear a little before the dialogue and disappear a little after.
- The color thresholds in the interface (green from 70%, yellow from 55%, red below; 50% and 25% for a single line) come from the prototype and **have not been calibrated on real films**. In films with music and sound effects, speech detection counts some non-speech as speech, so the absolute values will differ. The thresholds are shared constants so they are easy to adjust later.
- The score is for comparing "different subtitles for the same film" and "before and after adjusting", not an absolute measure of quality. The explanatory text in the interface is: "How much the subtitles overlap speech. Only a guide; trust your ears".

## Speech recognition

Speech detection only knows "when someone is talking", and in films with lots of music it is fooled by the music (Phase 0: Tears of Steel picked wrong in all five scenarios, off by up to 79 seconds). Speech recognition knows "what was said"; matching it with the subtitle lines gives a basis that music cannot fool.

### Recognition (the `asr` queue in `media`)

- When analysis finishes, if `align.asr` is on and the film has sound, `asr_state` is set to `pending`. Recognition has its own queue, one film at a time, so a recognition run of several minutes does not block other films' analysis.
- **The whole film is not recognized.** Evenly spread 30-second windows, one in the exact middle of each equal part; in total it listens to 40% of the duration, at most 6 minutes (a two-hour film gets 12 windows). Positions are not chosen by speech detection: in films with lots of music it points at the music (the three windows chosen that way on Tears of Steel heard nothing). `pickWindows` in `asr/text.ts`.
- Uses faster-whisper (`base` model, int8, CPU), installed in the image at `/opt/asr`; the model is downloaded at build time, and nothing goes out at run time (`HF_HUB_OFFLINE=1`). `media-scripts/asr.py`: ffmpeg decodes only each window's stretch of audio; Whisper's own VAD filter is on; using word-level timestamps, it splits into lines at sentence-ending punctuation or pauses of 0.8 seconds or more, and each line starts at its first word's time; a line already being spoken at the very start of a window is dropped (it actually started earlier). The language is set by the first window that is confident (probability ≥ 0.7), and all later windows use that language.
- The result is `media/<id>/asr.json` (`{language, model, windows, segments: [{start, end, text}]}`), counted in `analysis_bytes`. On failure it only records `error.asr = 'ASR_FAILED'` and does not retry; auto-align still works, just without this basis. "Analyze again" re-queues recognition that failed or was never done.
- Measured (Xeon X5650, no AVX): about 6 seconds per 30-second window (`base`); `small` takes about 20 seconds with about the same quality, so `base` is used. A 12-minute film with 10 windows takes about 1 to 2 minutes.

### Pairing

Pair recognized lines with subtitle lines (`Pair`: which subtitle line, and the time in the film where that speech starts). Search only within "the time range where this subtitle line could appear": at most 90 seconds from the subtitle's own time, at any known ratio as the rate (`sourceRange`).

- **The subtitles are in the same language as what was heard** (`zh-Hant`, `zh-Hans` and `zh` all count as Chinese): plain text matching, `textPairs` in `asr/text.ts`, no key needed. Up to three consecutive recognized lines can pair with up to two subtitle lines (a subtitle line often holds two or three sentences, and recognition also splits sentences); shared words must make up ≥ 0.6 of the shorter side, and the shorter side must be at least half the length of the longer; the beginning of each side must be contained in the other (the pair's time is the beginning's time); if something almost equally similar appears elsewhere in the same subtitle file, it is not paired (repeated dialogue). For Chinese, both sides are converted to Traditional characters before comparing.
- **Different languages**: handed to a language model (next section). When no model is configured, no pairing is done.

### Getting an alignment from the pairs (`asr/fit.ts`)

1. Rate: the known ratio under which the most pairs share the same offset. Wrong pairs land in random places and do not cluster, so a few wrong ones cannot win.
2. At that rate, pairs with the same offset form a group (at least 3 pairs; the first group at least 4); pairs in no group are wrong. Each group is one segment between cuts; the groups must come one after another in the subtitles without interleaving, and if they interleave, the smaller group is dropped.
3. The breakpoint between two segments lies among the lines that neither group pins down, and is decided with speech detection using the same objective function as the other methods.
4. Each segment is re-aligned against speech within ±0.5 seconds (subtitles usually appear a little before the sound).

This is one candidate, with method name `asr` (text pairing) or `asr-llm` (language model pairing).

### Pairs as referee (`pickWithPairs`)

All candidates (both ffsubsync modes, the sync core, recognition) are compared together: the one that agrees with the most pairs is the standard, and **any other candidate that contradicts the pairs the standard agrees with is out** (5% tolerance, for the occasional wrong pair); next, **a candidate with a segment where "recognition heard at least two lines in that time but none of them pair" is also out** (as long as some other candidate remains): in noisy stretches speech detection invents cut breakpoints that do not exist, and a breakpoint with no heard evidence is not trusted; stretches that were not listened to are not judged. The remaining candidates are chosen by the usual `pickAlignment`. With fewer than 4 pairs, the choice is made entirely the usual way. The definition of `agree` is unchanged. `AlignResult.heard` reports the language heard, how many pairs were made, how many the chosen result agrees with, the pairing method, and the reason the language model failed.

**When there are no pairs** (the subtitles are in another language and no language model is configured), the times at which recognized lines "start" serve as referee instead (`timingHits`): a subtitle line usually appears when a spoken line starts, and recognition is not fooled by music, so no language needs to be understood. A line whose start falls within 0.4 seconds of a recognized line's start counts as a hit; candidates with clearly fewer hits than the best (more than 10% fewer, at least 1) are out. When fewer than 8 lines were recognized, nothing is judged.

Tears of Steel's official French, German and Russian subtitles, each made wrong in four ways (23.7 seconds late, 47 seconds late, different frame rate, unchanged), with no language model: before the change, all 12 runs picked a segmentation invented by the sync core (off by up to 104 seconds); after the change, all 12 were within 0.03 seconds (the correct alignment hit 11 to 13 of 27 lines, wrong ones 2 to 9). When a breakpoint falls in a stretch recognition did not hear at all, no method can find it, and the one picked is the least wrong (`apps/server/scripts/other-language-eval.mts`).

Ranking (`subtitle.rank`) uses only text pairing and never asks a language model: one ranking can have up to thirty candidates, which would be thirty requests.

### Results on Tears of Steel

The official English subtitles as the answer, made wrong in the five Phase 0 ways, then aligned (`apps/server/scripts/asr-eval.mts`, run by hand; the video and recognition results are not in the repo):

| Scenario | Pairs (correct) | Chosen | Max error |
| --- | --- | --- | --- |
| Unchanged | 19 (15) | asr, one segment | 0.03 s |
| 2.4 seconds late | 19 (15) | asr, one segment | 0.03 s |
| 23.7 seconds late | 19 (15) | asr, one segment | 0.03 s |
| Different frame rate | 20 (15) | asr, ×1.04271 | 0.03 s |
| Different cut (12 seconds apart in the middle) | 19 (15) | asr, two segments, breakpoint exactly at line 38 | 0.03 s |

In Phase 0, all five of the same scenarios picked the sync core's wrong segmentation, with max errors of 37 to 79 seconds.

**In the full product flow (QA, 2026-10-06)**: after the dev environment downloaded, analyzed and recognized this film, English subtitles that were "23.7 seconds late, and really missing a 12-second stretch before line 67" were uploaded and auto-align was pressed in the workbench: the first 66 lines were all synced, and the last 10 lines were off by 12 seconds. The cause: the middle and later parts of the film are noisy, two of the 10 windows heard nothing, and after the breakpoint only 1 line was paired, not enough to form a segment (3 are needed). Before the "segments without heard evidence are not trusted" fix, the same subtitles picked a segmentation invented by the sync core, and the last 33 lines were off by 77 seconds. Those last 10 lines have to be caught by the user listening at checkpoints and fixed with anchors. "Correct" means the paired time is within 1 second of the official subtitles; the official subtitles' own times are only accurate to the whole or half second.

## Language model

When the subtitles and the film are in different languages (for example, an English film with Traditional Chinese subtitles), a language model decides "which recognized line and which subtitle line are the same thing said". Which model is used is decided by the profiles on the LLM settings page (since 2026-10-07; load balancing and fallback in [18-llm.md](18-llm.md); `align.llm`, formerly in Sources, has moved there). How each provider is called:

| Provider | How it is called |
| --- | --- |
| Claude (Anthropic) | The official Anthropic SDK, default `claude-opus-5-5`, effort `low`, answer constrained with structured output (JSON schema). With supported models such as Opus 5.5, server-side refusal fallback is turned on (`fallbacks: "default"`) |
| OpenAI, OpenRouter, self-hosted OpenAI-compatible services (vLLM, LM Studio, Qwen's compatible mode) | `POST <service URL>/chat/completions`, `response_format: json_object`, with the profile's temperature and maximum output length (OpenAI uses `max_completion_tokens`). When the server returns 400, drop `reasoning_effort`, `response_format`, `temperature` in that order and retry, remembering that this URL does not support it. `<think>` and code fences in the answer are stripped before parsing |
| Ollama | `POST <service URL>/api/chat`, `stream: false`, with `options.num_ctx` (length limit), `think: false`, and the answer's JSON schema (`format`). See "Why Ollama is its own kind" in [18-llm.md](18-llm.md) |
| Azure OpenAI | `POST <service URL>/openai/deployments/<deployment name>/chat/completions?api-version=…`, key in the `api-key` header |
| Azure AI Foundry | `POST <service URL>/models/chat/completions?api-version=…`, with the model name, key in the `api-key` header |

- **Called in `api`**, because only `api` has `SECRET_KEY` and can read a profile's key. `POST /api/subtitles/:id/auto-align` pairs before queuing the job (up to 45 seconds), puts the pairs in `tasks.input.heard`, and `media` continues the computation. On timeout or failure it is queued anyway, and the result's `heard.llmError` gives the reason (`NOT_CONFIGURED`, `AUTH`, `RATE_LIMITED`, `REFUSED`, `BAD_RESPONSE`, `UNREACHABLE`, `TIMEOUT`).
- One request per listening window; the number sent at once is the sum of the first-tier profiles' "concurrent requests" (at most 16). Each request is that window's recognition result plus the subtitle lines that could match in time (at most 300 lines). The prompt states that subtitle times are unreliable and to go by meaning and order; to return only confident pairs, not to pair interjections or singing, to use each line at most once, and to keep the order. Any number in the answer that is not in the prompt is discarded. If some windows fail, the pairs from the other windows are still used.
- Only dialogue text and seconds are sent; no video, audio, film title or user data.
- If the key is rejected (`AUTH`), the remaining windows are not sent. Cooldown and switching profiles on failure are handled by the profile pool ([18-llm.md](18-llm.md)), and usage is recorded in `llm_usage` (purpose "Auto-align").
- Each person can press auto-align at most 20 times every 10 minutes (whether or not a language model is used); beyond that it returns `RATE_LIMITED` with how many seconds to wait; the workbench says "Auto-align was pressed too often. Try again in N minutes."

**Measured (2026-10-06, Ollama server provided by Brian, Qwen 3.8 27B Q4_K_M)**: Tears of Steel's official French, German and Russian subtitles, each made wrong in five ways (unchanged, 2.4 seconds late, 23.7 seconds late, different frame rate, cut 12 seconds apart), with the English recognition results handed to the model to pair: all 15 runs within 0.04 seconds. Each subtitle file produced 21 to 23 pairs (16 to 20 correct), more than plain text matching on the English subtitles (19 pairs, 15 correct), because the model understands paraphrase. One alignment spent about 25 seconds on the model (10 windows, 3 requests at a time).

Reasoning models like Qwen 3 "think" before answering by default, which this job does not need: requests carry `reasoning_effort: "none"` to turn it off, which took the same question from 45 seconds to 3 seconds with the same answer. When a service that does not recognize this field returns 400, the request is automatically resent without the field, and the field is not sent again.

**How far this is verified:** No keys for Claude or Qwen's cloud service were available, so the pairing quality of cloud models has not been tested. The protocol was tested against a local fake server (unit tests). A real Qwen (Qwen 2.5 3B on local Ollama) given one window of English recognition from Tears of Steel against French subtitles: it answered in the required format and paired correctly, but took 283 seconds on this CPU without AVX, so local models are not practical on this machine and a cloud service should be used.

## Align by other subtitles

When the same film already has a synced subtitle track, use it to sync other subtitles (Brian, 2026-10-06). In the workbench, "By other subtitles" picks a subtitle track; pressing "Align to these" calls the same endpoint with an extra `referenceId` (`tasks.input.referenceId`). The code is in `apps/server/src/subtitles/reference.ts` and `computeReferenceAlignment` in `align.ts`.

**Treat the reference subtitles as the film.** The reference subtitles are given their current segments and per-line edits, with deleted lines removed; the times of these lines are "where someone is speaking", far more accurate than speech detection:

- **Timing**: each line becomes one stretch of "speech" (overlaps merged) and goes through the same computation as auto-align (the built-in matching besides ffsubsync, trying all common rates and whole-film offsets, splitting allowed). When one line is split into two on one side and is one line on the other, the time covered is the same, so it is unaffected.
- **Text**: when both subtitle tracks are in the same language (for example two English files, or Traditional and Simplified Chinese), the reference lines are treated as speech recognition results and paired with the same text matching (`sameLanguagePairs`: one-to-two and two-to-one both pair), with pairs as referee, as in the speech recognition section. With different languages only timing is used; **no language model**: measured, it takes 45 to 60 seconds, while timing alone is already within 0.5 seconds.
- **No audio needed**: works even before the film has finished analysis. With speech data, the sync score is computed against the film's speech as usual; without it, against the reference subtitles.

**When the reference subtitles themselves are not synced.** The result always follows the reference subtitles (the user picked them); but when speech data exists, the reference subtitles are also aligned to the film's speech (no splitting). If they would move more than 1 second and the fit improves by 3 percentage points or more, `reference.offBy` reports how many seconds off they are, and the workbench warns the user. During dev environment QA, a subtitle track marked confirmed but actually 23.7 seconds late really was used as a reference.

**Lines unrelated to the film.** The beginning and end often have lines like "字幕：某某" (Subtitles: so-and-so) or "www.…":

1. Lines within 10 lines of either end that look like credits (URLs, @, 字幕, 翻譯, 校對, 時間軸 (subtitles, translation, proofreading, timing), subtitle, synced, opensubtitles, yify and similar words) **do not take part in the computation**, and when applied they follow the segment they are in.
2. In the computed segments, a first or last segment with fewer than 4 lines is merged into its neighbor: something that short at an end is credits or noise, not a cut.
3. After aligning, lines within 10 lines of either end that have no reference line within 1 second before or after, and that look like credits or are more than 20 seconds from every reference line, are put in the result's `extraLines` (line `id`s). The workbench **asks the user** whether to delete them (an undoable action); it never deletes them on its own.

**Results on the test fixtures** (`reference.test.ts`, and the manual `apps/server/scripts/reference-eval.mts`):

- The synthetic 21.5-minute test film with `truth` as the reference: different frame rate plus two credit lines, a cut, every line split in two, every two lines merged into one, all within 0.2 seconds, and both credit lines found.
- Tears of Steel's English subtitles as the reference, French, German and Russian subtitles each made wrong in four ways (2.4 seconds late, 47 seconds late, different frame rate, cut) plus two credit lines: all 12 runs within 0.03 seconds. Then every line of the target subtitles randomly jittered by ±0.4 seconds, with random splits and merges (`MESSY=1`): all within 0.5 seconds, credit lines all found, and the cut also found. Each run under 1 second.

## Packing (`export.mux`)

### When an export is created (`api`)

1. Validate: every subtitle track is confirmed; exactly one is the default track; the file name is valid.
2. Estimate the size: `media_files.size_bytes × 1.01 + 1 MB` (this is `Workspace.exportNeedBytes`; the formula is written only in `exportNeedBytes()` in `packages/shared`, 1 MB is 1,048,576 bytes, and any fraction after multiplying is rounded up). `storage_admit` in a transaction.
3. Once admitted, **right away** apply each subtitle track's sync doc and write the final SRT: `applyDoc` → `toSrt`, saved at `/data/exports/<id>/tracks/<n>.srt` (UTF-8). This way, later edits to or deletion of the subtitles do not affect this export.
4. Create the `exports` (`queued`) and `tasks` rows, `NOTIFY paiban_media`. Update this film's `last_used_at`.

`toSrt` rules: deleted lines are not output, negative times are clamped to 0, each line lasts at least 0.2 seconds, lines are sorted by start time and renumbered from 1.

### The job itself (`media`)

```bash
ffmpeg -v error -nostdin -y -progress pipe:1 -nostats \
  -i "$SRC" -i tracks/0.srt -i tracks/1.srt \
  -map 0:V -map 0:a? -map 1:0 -map 2:0 -c copy \
  -metadata title="片名 (年份)" \
  -metadata:s:s:0 language=chi -metadata:s:s:0 title="繁體中文" -disposition:s:0 default \
  -metadata:s:s:1 language=eng -metadata:s:s:1 title="English"  -disposition:s:1 0 \
  -f matroska "$OUT.part" && mv "$OUT.part" "$OUT"
```

(`片名 (年份)` is a placeholder for "Title (Year)".)

The reason for each option, all tested:

| Option | Reason |
| --- | --- |
| `-c copy` | Video and audio packet hashes are identical to the original, quality is unchanged, and speed is limited only by the disk |
| `-map 0:V` (uppercase) | Takes only real video tracks. Lowercase `0:v` would also pack the cover art as a second video track |
| `-map 0:a?` | All audio tracks; the question mark lets sources without an audio track be packed too |
| The original file's subtitle tracks are not mapped | Subtitles embedded in the original are not carried over; the MKV contains only subtitles the user confirmed |
| `-metadata title=` | In downloaded files, the container title is often an ad string |
| Default track first, with `default` set | Players show it automatically |
| `.part`, then rename | A file visible under its final name is always complete |

Language tags:

| Subtitle language | `language` | `title` |
| --- | --- | --- |
| `zh-Hant`, `zh` | `chi` | 繁體中文 |
| `zh-Hans` | `chi` | 简体中文 |
| `en` | `eng` | English |
| Other | The matching three-letter code (`jpn`, `kor`, …), `und` if there is none | The language's own name (日本語), or the original language code if there is none |

ffmpeg can only write three-letter language codes, so Traditional and Simplified are told apart by `title`. The above are the titles when someone with a Traditional Chinese interface exports; when someone with an English interface exports, the titles are English language names (Traditional Chinese, Simplified Chinese, English, Japanese, …; `zh` is also Traditional Chinese), written into `exports.tracks` when the export is created (Brian, 2026-10-08). These titles are strings written into the file, not interface copy.

**Timing**: the original audio often has a slightly negative start time (AAC encoder delay). When packing into MKV, ffmpeg shifts **all** tracks later by the same amount (46 milliseconds for the test clip), subtitles included, so the relative timing of video, audio and subtitles is unchanged. There is no need to compensate for this amount yourself, and you should not.

**Check once when done**: use ffprobe on the output file (while it is still `.part`; rename only after the check): the number of video tracks (not counting cover art, same as `0:V`) and audio tracks must match the original, and the number of subtitle tracks must equal the number requested. Otherwise it counts as a failure (`VERIFY_FAILED`).

**Queue**: packing is a separate queue in `media`, running only one at a time, and it does not wait on preview assets or analysis, nor they on it. Progress is computed from `-progress`'s `out_time_us` divided by the duration, writing `exports.progress` and `tasks.progress` at most every 2 seconds, with `NOTIFY` (`export`). Completion and failure notifications carry the film title, version and file name (plus the code on failure), and `link` points to the Export tab of that film's workspace.

### Four ways it ends

| Case | Handling |
| --- | --- |
| The film is removed midway | `torrent`, in the deletion transaction, marks this export `failed` (`SOURCE_MISSING`), sets the reservation to zero and notifies the creator. At its next check the packing job finds its row is no longer `running`: kills ffmpeg, deletes `.part` and `tracks/`. Not retried |
| Done | `state = 'done'`, write the actual `size_bytes`, set `reserved_bytes` to zero, delete `tracks/`, notify the creator (`export.completed`) |
| Failed (after both attempts fail) | Delete `.part` and `tracks/`, `state = 'failed'`, `error_code`, set `reserved_bytes` to zero, notify the creator (`export.failed`). After the first failure, `tracks/` and the reservation are kept for the second attempt |
| Cancelled (`cancel_requested`) | Kill ffmpeg, delete `.part` and `tracks/`, delete the `exports` row |

Failure codes (`ExportErrorCode`):

| Code | Meaning |
| --- | --- |
| `SOURCE_MISSING` | The source video file is gone, or the film was deleted during packing |
| `MUX_FAILED` | ffmpeg failed |
| `VERIFY_FAILED` | The check after completion did not pass |
| `DISK_FULL` | The disk is full |

A failed export stays on the list so people can see why; the user can delete it or simply create a new one. It cannot be "retried": the temporarily saved subtitle tracks have already been cleaned up, and the subtitles may have changed since.

## Common rules for jobs

- **Visible jobs have a row in `tasks`**: analysis, preview assets, alignment, ranking, export, recount. Start, progress and end all update it, with `NOTIFY` (`task`). Who creates the row: see the table below.
- **Claim first.** At the start, the handler uses a conditional update to change the corresponding row from "waiting" to "running" (also checking that the download's `want` is not `remove`). If it updates nothing, finish right away: someone is already doing this, or it is no longer needed.
- **Check every 2 seconds while running**: the corresponding row still exists, its state is still "running", the download's `want` is not `remove`, and the export's `cancel_requested` is not true. If any fails, kill the child process, clean up its own partial output, mark its own `tasks` row `cancelled` (if not already marked) and finish.
- **Check again before writing files.** Check the same conditions again before creating folders or renaming `.part`.
- **The final update must be conditional.** When setting the state to done, put the conditions in the same statement: the row still exists, its state is still the "running" it claimed, and the download's `want` is not `remove`. If it updates nothing, the thing was deleted midway, is being deleted, or was cancelled: delete the files it just wrote (and the folders it created, if now empty) and finish. This rule means "delete" never has to wait for any job to stop ([03-data-model.md](03-data-model.md)).
- Child processes are always started with arguments as an array, never through a shell. File paths always come from the database, never from the request.
- Large outputs (preview video, audio file, export) are written to `.part` first and renamed when complete. Small files for subtitles and candidates are prepared in the work directory and the whole folder is moved over ("Disk layout" in [02-architecture.md](02-architecture.md)).
- **A failed job is retried once automatically, two attempts in total.** First failure: clean up its own partial output, the row returns to "waiting", the reservation and `tracks/` are left alone; the same `tasks` row also returns to `queued`, with `attempts` incremented by 1. The next reconciliation queues it again. Only when the second attempt also fails (`attempts` is already 1) is it really failed: the state becomes `failed`, the error code is recorded and the reservation is released. A program restart does not count as a failure and does not increment `attempts`. The counter is one per `tasks` row: whether the audio file or the preview video fails, the whole preview asset job is retried once (whichever one is already done is not redone).
- **Not retried automatically:**
  - Foreground alignment (`subtitle.align`), subtitle lookups and fetches: it is faster for the user to press again.
  - A single candidate in a ranking (`subtitle.rank`): a failure is recorded as a failure, and ranking moves on to the next one.
  - A probe result of "cannot read" (`PROBE_FAILED`) or "no audio track" (`NO_AUDIO`): retrying gives the same result, so it is recorded directly. A probe-only job has no `tasks` row and so no counter; one failure is a failure.
  - An export whose source film no longer exists (`SOURCE_MISSING`).
- **When the `media` program starts**: empty `/data/tmp/work`; delete leftover `*.part` under `/data/media` and `/data/exports` (partial output from last time, not anyone's files); move anything stuck in "running" back to "waiting" (table in the next section); run one reconciliation.

### Who creates the `tasks` rows

| Kind | Who, and when | `subject` |
| --- | --- | --- |
| `analyze`, `preview` | `media`, during reconciliation, at the same time it queues the job for that row | Film title, version |
| `export` | `api`, when the export is created | Film title, file name |
| `align` | `api`, when it receives an "Auto-align" request | Film title, subtitle language |
| `rank` | `api`, when it receives an "Auto-align and rank all" request | Film title |
| `rescan` | `api`, when it receives a "Recount usage" request | (empty) |

`input` records what the job is for (the id of the video, subtitle or export, or the batch of candidates for a ranking); reconciliation and retries rely on it.

When a `tasks` row becomes `cancelled`: its subject was deleted or cancelled. The film was removed (`torrent` marks it in the deletion transaction; unfinished exports are the exception, their `tasks` are marked `failed`, see "Four ways it ends"), the preview file was deleted by an administrator, the export was cancelled or deleted while queued (`api` marks it), or the job itself found its subject gone.

## Reconciliation

`media` reconciles at three times: at startup, on receiving `NOTIFY paiban_media`, and every 60 seconds. Films being deleted (`want = 'remove'`) are always skipped.

**At startup, first restore whatever stopped halfway last time** (done only once at startup, before the first reconciliation):

| Stopped at | Changed to |
| --- | --- |
| `media_files` with `probe_state`, `analysis_state`, `audio_state` or `proxy_state` `running` | `pending` |
| `exports.state = 'running'` | `queued`. But one whose `cancel_requested` is already true (restarted midway through cancelling) is wrapped up directly: delete `tracks/`, delete the row, mark its `tasks` `cancelled` |
| `subtitle_candidates.align_state = 'running'` | `queued` |
| `tasks.state = 'running'`, kind `analyze`, `preview`, `export`, `rank`, `rescan` | `queued` |
| Unfinished `align` in `tasks` | `failed`: the request waiting for it is long gone |

**Each reconciliation does four things:**

1. **Queue jobs for waiting rows.** If the same row already has a queued or running job, do not queue again. For the two kinds that create `tasks`, create a new row only when there is no unfinished job of the same kind; if there is one (the row that returned to `queued` after a first failure), reuse it.

   | Case | Queue |
   | --- | --- |
   | `probe_state = 'pending'`; or `probe_state = 'ready'` and `analysis_state = 'pending'` | `media.analyze`. When `analysis_state` is `pending`, create an `analyze` row in `tasks`; when only probing is needed, do not |
   | `probe_state = 'ready'`, and `audio_state` or `proxy_state` is `pending` | `media.preview`, creating a `preview` row in `tasks` |
   | `exports.state = 'queued'` | `export.mux` |
   | A `rescan` in `tasks` is `queued` | `storage.rescan` |
   | In an unfinished ranking, candidates whose file has been fetched (`fetch_state = 'ready'`) and whose `align_state = 'queued'` | `subtitle.rank` |

2. **Settle rankings.** For each unfinished `rank`: among its batch of candidates, look at those that **still exist**, count those with a result (`align_state` is `done` or `failed`, or `fetch_state` is `failed`), and update progress; when all that still exist have a result, mark it `done`. Candidates removed by the user midway, or replaced by new search results, are not counted, otherwise the ranking would wait forever for a candidate that no longer exists. Each `subtitle.rank` job also calls the same logic after each candidate, so progress is live; removing candidates and searching again also send `NOTIFY paiban_media`; reconciliation itself is just the safety net.

3. **Handle stuck candidates.** Those with `fetch_state = 'fetching'` for more than 10 minutes are changed to `failed` (`DOWNLOAD_FAILED`); if it is waiting for a ranking, its `align_state` is also changed to `failed`.

4. **Wrap up jobs with no subject.** Unfinished `tasks` whose subject no longer exists are marked `cancelled`. For `export` jobs, what is checked is whether that export is still `queued` or `running`.

Reconciliation itself deletes no files, and deletes nothing based on time; item 3 changes state, not files.

## Manual retry

Failed jobs on the System status page have "Retry" (`POST /api/admin/tasks/:id/retry`). What it does depends on the kind:

| Kind | What retry does |
| --- | --- |
| `analyze` | Sets `analysis_state` back to `pending`, same as `POST /api/media/:id/analyze` |
| `preview` | Same as `POST /api/media/:id/proxy`: failed assets are set back to `pending`. The reservation was released on failure, so **it must pass admission again** |
| `rescan` | Queued once more |
| `align`, `rank`, `export` | Cannot be retried (`Task.retryable` is false, and the interface shows no button). Alignment: the user presses again in the workbench; ranking: press "Rank again" on the Subtitles tab; export: create a new one |

A retry creates a new `tasks` row; the original failed row is kept as a record. New analysis and preview asset jobs are created by `media` at the next reconciliation, so the endpoint returns the original row (unchanged); the new row appears on the System status page with an `admin` event.

## Not yet verified

| Item | Risk |
| --- | --- |
| Speech detection quality on real films (music, sound effects, several people talking at once) | The accuracy of the score and auto-align depends on it. Phase 0 should try it with a legally obtained real film |
| Accuracy of both alignment methods on real films | Same as above |
| Score thresholds | See above |
| 2160p HEVC transcoding speed on the target machine | May be very slow. Only affects how soon the preview file is available, not whether syncing is possible |
| Whether YTS MP4s play directly in the browser (`moov` position, 5.1-channel AAC) | If not, those files also need a preview file. Phase 0 item 7 checks this with similar files made from open movies; real YTS files will only be encountered when Brian actually uses it |
| Adding a BCP 47 language tag (`zh-TW`) with `mkvpropedit` | Not tried; listed as an optional improvement |
| The exact way to configure dedup keys, retries and concurrency in pg-boss 12 | This document only describes the required behavior. Its documentation is authoritative for how to do it |
