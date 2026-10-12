# Test fixtures

Every file here was synthesized for this project: the dialogue was written, the voices are text-to-speech, the picture was drawn by ffmpeg. **There is no third-party audio, video or subtitle content**, so it can go in the repo, in tests and in CI.

## Videos

A 92.4-second "film": two people (A, B) looking for a tape in an office, 26 lines of English dialogue in all. The picture is two squares; whoever is speaking lights up. Below them is a waveform, and a timecode in the top left. Between lines 13 and 14 there are 13 seconds without dialogue (only a few muffled thuds of things being rummaged through); before line 22 there's an elevator chime. In the background there's a very faint noise floor and a sustained tone, so that speech detection isn't working in complete silence.

| File | Contents | Use |
| --- | --- | --- |
| `clip.mp4` | H.264 8-bit, 480×270, 23.976 fps, AAC mono. 1.4 MB | The "plays directly" version. The main material for download, analysis, sync and export |
| `clip.hevc10.mp4` | The same picture, HEVC 10-bit, AAC 5.1. 2.3 MB. Every frame's timestamp is the same as in `clip.mp4` | The "can't play directly" version: the audio file needs transcoding, and a preview file has to be made |
| `clip.webm` | The same content, VP9 + Opus. 2.4 MB | Browser tests that really need to play video use this, so they don't depend on whether the test Chromium can decode H.264 (the version at handover couldn't, Playwright 1.63 can; see `docs/15-testing.md`). It also counts as a "plays directly" version (the rules are in `docs/08-media-pipeline.md`) |

## Analysis results

| File | Contents |
| --- | --- |
| `data.json` | The prototypes' data pack: `duration`, `fps`, `speechHz` (100), `speechFrames` (9242), `speech` (42 speech regions, in 10-millisecond frames), `peaksPerSec` (50), `peaks` (base64; 4,620 pairs of signed-byte minimums and maximums), `cues` (26 lines, each with `id`, `start`, `end`, `zh`, `en`, `who`) |
| `clip.npz` | ffsubsync's speech detection cache for `clip.mp4` (`--vad webrtc`). Its `speech` array is the same data as `speech` in `data.json` |

Running `reference/pipeline/analyze.sh` on `clip.mp4` must produce a `speech.json` and `peaks.bin` exactly identical to what's in `data.json`.

The other two files have re-encoded audio, so their speech detection results differ very slightly; don't compare for exact equality when testing with them:

| File | Compared with `clip.mp4` | Effect on tests |
| --- | --- | --- |
| `clip.hevc10.mp4` | About 1% of frames differ | Score differs by less than 1 percentage point |
| `clip.webm` | 28 of 9,242 frames differ (44 speech regions detected, not 42) | Score around 79.5%, shown as 79% (`clip.mp4` is 79.6%, shown as 80%). The offset, rate and segments auto-align computes are exactly the same as for `clip.mp4` |

Tests that use `clip.webm` allow plus or minus 1 percentage point when comparing scores.

The `cues` times are "the times a subtitler would set": appear 0.05 seconds before the line is spoken, stay 0.35 seconds after it ends, and don't overlap the next line. So the overlap between the correct subtitles and speech is 80%, not 100%.

## Subtitles

`truth.*` are subtitles with correct timing. The others are deliberately wrong, simulating the three common problems of downloaded subtitles.

| File | Problem | What it takes to fix |
| --- | --- | --- |
| `truth.zh-TW.srt`, `truth.en.srt` | None | |
| `late.zh-TW.srt` | 2.4 seconds late overall | Offset −2.4 |
| `rate.zh-TW.srt` | Made for a 25 fps version (`t × 23.976 / 25 + 0.8`) | Rate ×1.0427, offset −0.834 |
| `cut.zh-TW.srt` | The cut these subtitles were made for is missing a 12-second scene after line 13 (first 13 lines `t − 1.2`, after that `t − 13.2`) | Two segments: +1.2 and +13.2 |

The same `late` subtitles in other encodings and formats:

| File | What it tests |
| --- | --- |
| `late.zh-TW.big5.srt` | Big5 |
| `late.zh-TW.utf16le-bom.srt` | UTF-16 LE, with BOM, CRLF line endings |
| `late.zh-CN.srt` | Simplified Chinese (UTF-8), converted from Traditional with opencc-js |
| `late.zh-CN.gb18030.srt` | Simplified Chinese, GB18030 |
| `late.zh-CN.to-zh-TW.expected.srt` | What converting the Simplified version above back to Traditional (`cn` → `twp`) should give |
| `late.bilingual.ass` | ASS: two lines per cue, Chinese and English, with style tags, plus one comment line and one drawing command line (both should be skipped). UTF-8 with BOM, CRLF |
| `late.en.vtt` | WebVTT |
| `archive.zip` | An archive of the kind subtitle sites commonly serve: one Big5 Traditional Chinese subtitle, one English subtitle, one readme text file, one `__MACOSX` junk file |

`archives/` (generated in phase 0 with `scripts/phase0/make-archives.sh`, in a temporary Debian container using RARLAB's `rar` 7 and `7zip`; neither tool is in the product's image):

| File | Contents | Expected result |
| --- | --- | --- |
| `archive.rar` | The same four entries as `archive.zip`, RAR5 | Same as `archive.zip`. `rar` 7 can no longer write RAR4, so there is no RAR4 sample |
| `archive.7z` | Same as above, 7z | Same as above |
| `hostile.traversal.zip` | One normal subtitle plus a `../../escaped.srt` | Whole archive rejected (`ARCHIVE_INVALID`) |
| `hostile.absolute.zip` | One normal subtitle plus a `/tmp/absolute.srt` | Whole archive rejected |
| `hostile.symlink.zip` | One normal subtitle plus a symbolic link pointing to `/etc/passwd` | Whole archive rejected |
| `hostile.bomb.zip` | One normal subtitle plus an entry that's 60 MB when extracted (62 KB compressed) | Whole archive rejected |
| `hostile.many.zip` | 201 subtitle files | Whole archive rejected (limit 200) |
| `nosubtitle.zip` | Only one text file | `NO_SUBTITLE` |
| `broken.zip` | Header looks like zip, content isn't | `ARCHIVE_INVALID` |

The bsdtar 3.7.4 in the image can extract the first two, with contents exactly the same as `archive.zip`. On its own it only rejects entries containing `..` (extracting the rest anyway) and strips a leading `/`; symbolic links are extracted as-is, and count and size are not limited. So these checks have to be done by our own code (`docs/agent-notes.md`).

## ffsubsync results

| File | Contents |
| --- | --- |
| `ffsubsync/<scenario>.linear.out.srt` | Output of `ffsubsync clip.npz -i <scenario>.zh-TW.srt -o …` |
| `ffsubsync/<scenario>.split.out.srt` | Output with `--split-penalty` added |
| `expected.ffsubsync.json` | The offset, rate and segments ffsubsync itself printed on each run, and the error compared with `truth` |

With these, the code that parses ffsubsync output, recovers the transform and picks a result can be unit tested without installing ffsubsync (`packages/shared/src/sync-core/core.test.ts` does exactly this).

## Longer fixtures

`film/film.json`: speech data (557 regions) for a 21.5-minute synthetic film and four sets of subtitles (180 lines each): `truth`, `late` (+2.37 seconds), `pal` (`t × 23.976 / 25 + 1.1`), `cut` (40 seconds missing after line 33). The video itself is too large to include; this file is enough to test how the sync core behaves on longer material with bigger discrepancies. Here `truth` is the interval in which each line is actually voiced, so the correct subtitles score 95%.

## Regenerating

```bash
# Run inside the fixtures/ folder.

# Simplified versions and expected conversion results. Uses the opencc-js installed by reference/subtitles:
(cd ../reference/subtitles && npm ci)
node make_simplified.mjs

# Everything else. Run with the Python that has ffsubsync 0.5.1 installed (it uses the srt package ffsubsync brings in):
FFSUBSYNC=/path/to/venv/bin/ffsubsync /path/to/venv/bin/python make_fixtures.py
```

`clip.mp4` and `data.json` are sources and are never regenerated. The other two video files were converted from `clip.mp4`:

```bash
# clip.hevc10.mp4 (the command actually used)
ffmpeg -i clip.mp4 -map 0:v:0 -map 0:a:0 -c:v libx265 -preset medium -crf 30 -pix_fmt yuv420p10le -tag:v hvc1 \
  -fps_mode passthrough -c:a aac -ac 6 -b:a 192k -movflags +faststart clip.hevc10.mp4

# clip.webm (the original parameters weren't kept; something like this)
ffmpeg -i clip.mp4 -c:v libvpx-vp9 -crf 34 -b:v 0 -fps_mode passthrough -c:a libopus -b:a 64k clip.webm
```
