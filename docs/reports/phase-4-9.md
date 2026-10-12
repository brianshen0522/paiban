# Report: analysis, subtitles, sync, export, speech-recognition alignment, and launch preparation (2026-10-06)

Continues from [phase-1-3.md](phase-1-3.md). Brian's request from the night before: a complete, working system ready to launch; subtitle syncing that combines Whisper / Qwen speech recognition with a language model, recognizing in batches rather than running the whole film; a finished front end; and QA, stopping to fix any problem before continuing.

## Update (work continued afterwards)

- **Subtitles in a different language with no language model configured**: now uses "when each recognized sentence starts" as the judge, which doesn't require understanding the language. Tears of Steel's French, German and Russian subtitles, each with four kinds of errors, 12 runs in total, were all picked wrong before (off by up to 104 seconds); now all are within 0.03 seconds.
- **Speech recognition appears among the background tasks on "System status"**, and a failure can be retried with "Retry" (migration `0003_asr_tasks.sql`).
- **Auto-align rate limit**: 20 per person every 10 minutes; when exceeded, the workbench says how long to wait.
- **Front-end code splitting**: the workspace and admin pages are now downloaded the first time they're opened, and the JavaScript the home page downloads dropped from 613 kB to 326 kB.
- **Test stability**: tests in the image are limited to 4 concurrent workers; the tolerance of the send pacing test was changed to a reasonable value, with the reason written in the test. Afterwards, all 294 tests passed three runs in a row in the image.
- 8088 has been redeployed, and the database was upgraded to `0003` automatically.

## Conclusion

The whole flow, from search to getting an MKV with subtitles, works end to end in the browser, deployed at `http://localhost:8088`.

Auto-align now includes speech recognition:

- Subtitles in the same language are compared by text directly.
- Subtitles in a different language are handed to a language model (Claude, or an OpenAI-compatible service such as Qwen).

On Tears of Steel (a Blender open movie), the five kinds of errors from phase 0 were off by up to 79 seconds before; now all are within 0.03 seconds.

**Not verified**:

- The real matching quality of cloud language models. I don't have a key; see "What you need to do".
- Queries to the real subtitle sources.

## How to sign in

- URL: `http://localhost:8088` (from another computer, this machine's IP works too)
- Username and password: `BOOTSTRAP_ADMIN_USERNAME` and `BOOTSTRAP_ADMIN_PASSWORD` in `deploy/.env`. Run `grep BOOTSTRAP deploy/.env` on this machine to see them. After signing in, please change the password in "Profile".

## What was done

### Auto-align with speech recognition and a language model (the approach you specified)

1. **Recognition**:
   - After analysis finishes, faster-whisper (the `base` model, installed in the image, no outbound access at run time) listens to evenly distributed 30-second windows.
   - In total it listens to 40% of the film's length, at most 6 minutes; a two-hour film gets 12 windows.
   - On this 2010 Xeon (no AVX), each 30 seconds of audio takes about 6 seconds, and a 12-minute film about 1 to 2 minutes.
   - Recognition has its own queue and doesn't block analysis of other films.
2. **Matching**:
   - Same language: compare text (Chinese is first normalized to Traditional characters); no key needed.
   - Different language: api calls the language model, one request per window, sending only the dialogue text and timestamps.
   - With no model configured, subtitles in a different language still rely only on speech detection as before.
3. **Fitting**:
   - From the matches, compute the rate (chosen from known ratios), the offset and the cut breakpoints, forming a new candidate.
   - The matches also act as a judge: candidates that contradict them are eliminated; segments where recognition heard two or more sentences in that time but none of them match are not trusted either.
4. **Interface**:
   - The workbench's message bar says things like "Speech recognition heard English and made 19 pairs with the subtitles; this result agrees with 13 of them", and gives the reason when the model fails.
   - "Sources" has a new "Auto-align" card: recognition on/off, model choice, key, and "Test model".

Details are in the "Speech recognition" and "Language model" sections of `docs/08-media-pipeline.md`.

### Other features

- **Video processing**: probing, waveform, speech detection, preview audio and preview video, recalculating usage, the System status page.
- **Subtitles**:
  - Six sources: JustSubtitles, YIFY, Assrt, the Zimuku entry point, uploads, plus TMDB mapping.
  - Archives (zip / 7z / rar), encoding and language detection, Simplified-to-Traditional conversion, auto-align and rank them all, adding.
  - Keys stored encrypted.
- **Sync workbench** (all of docs/09):
  - Playback, subtitle lines, timeline, auto-align, snapping, offset and rate, anchors, segments, checkpoints.
  - Undo / redo, confirmation, and conflict handling when two people edit at the same time.
- **MKV export**: choosing subtitle tracks and the default track, space checks, packing (no re-encoding), downloads that support resuming, deletion.
- **Launch preparation**:
  - `docs/deploy.md`: installation, every `.env` entry, opening ports, two ways to do HTTPS, updates, backup and restore, moving to another machine, FAQ.
  - `docs/guide.md`: a five-minute user guide.
  - Went through the security checklist item by item.
  - Checked dependencies.

## How it was verified

- **Automated tests**:
  - 292 server tests run in the image (ffmpeg, ffsubsync, bsdtar and speech recognition are all real).
  - 24 web, 19 shared package.
  - Type checking and lint both pass.
- **Offline end-to-end flow test** (`pnpm test:image test/e2e-flow.test.ts`, about 1.5 minutes), entirely with fake YTS and local seeding, from search all the way to deletion:
  - Search → download → analysis → speech recognition → subtitle search → add → auto-align → confirm → export → download the MKV with Range.
  - Check the MKV's tracks and language tags with ffprobe.
  - Confirm nothing is left after deletion.
- **Browser QA**: in the dev environment, with Tears of Steel locally seeded and posing as a version. Walked through as a user would:
  - Set up YTS, search, download the 540 MB version, wait for analysis and recognition.
  - Upload deliberately mistimed English and French subtitles, rank, auto-align in the workbench, confirm, export, download the MKV.
  - 17 pages at 400 px wide and at desktop width, in light and dark, with no horizontal scroll bar and no program errors.
- **Deployment**: 8088 has been updated to the latest version, and the database was upgraded to `0002_asr.sql` automatically. Searching the real YTS finds 77,580 films; only searched, nothing downloaded.

## Problems found and fixed during QA

| Problem | Fix |
| --- | --- |
| On noisy stretches, auto-align trusted cut breakpoints made up by speech detection: for subtitles "23.7 seconds late, with a 12-second chunk missing in the middle", the last 33 lines were off by 77 seconds | Segments where recognition listened but not a single sentence matched are not trusted. The same subtitles now have the first 66 lines all correct and the last 10 off by 12 seconds (only 1 sentence was heard after the breakpoint; see the limitations below) |
| A disabled account or a demoted administrator kept receiving events on already-open live update connections | Sign-in state and identity are checked every 25 seconds, and the connection is cut if they changed |
| A film's workspace never showed exports (the endpoint always returned an empty list) | Wired up the real query (two agents each found and fixed the same problem) |
| Responses from the language model service had no size limit, and redirects were followed with the key carried along | Redirects aren't followed, and responses over 1 MB are aborted; added tests confirming that no key or dialogue appears in the logs |
| Dev environment: fake YTS read the previous seeding list; the long-film version didn't show up in the list | Start only after the seeding list is written; extra films are listed as separate versions |
| The "Shared settings" card on the Sources page was wider than the others | Fixed |

## Known limitations and what isn't verified

- **Cloud language models haven't been tested**. The protocol was tested against a local fake server. A real Qwen 2.5 3B was also run on local Ollama: English recognition against French subtitles gave the right format and correct matches, but on this CPU one request took 283 seconds, so this machine needs a cloud service.
- ~~With no language model configured, subtitles in a different language may still be thrown off by speech detection on films with a lot of music~~: improved; see the update at the top.
- **On very noisy films, in stretches where recognition hears nothing, breakpoints can't be found accurately**. Of the 10 windows in Tears of Steel, 2 heard no speech at all. The rest depends on listening at checkpoints and fixing with anchors. The workbench warns "The two alignment methods disagree. Listen to a few more checkpoints."
- **Time-sensitive tests**: they occasionally failed when the machine was busy, because of load: the image tests originally ran 7 workers at once, and the files running ffmpeg took the time. Limited to 4, after which three runs in a row all passed. The `subtitles` search one (Chinese title not written) I couldn't reproduce; four copies running at once all passed too.
- **Other things not verified**:
  - Real subtitle sources, which need your TMDB key and Assrt token.
  - Playback in Safari / Firefox; screen readers; ARM.
  - Download behavior over long periods of operation.

## Differences from the spec that need your confirmation

All recorded in `docs/changes.md` and `docs/agent-notes.md`:

- **Speech recognition details**:
  - The number and length of windows, using the `base` model.
  - Ranking doesn't call the language model: one ranking covers up to 30 subtitle tracks, which would be 30 requests.
  - The language model is called in api: only it has access to the key.
  - When Claude is selected, the default is `claude-opus-5-5`, with the official "switch to another model on refusal" fallback turned on.
- **Subtitle fetching is done by api** (the spec says media): Assrt's download URLs are temporary and can't be handed to another program.
- **The default export file name is always `.zh-TW.mkv`**: per the spec, even when there are only English subtitles. Do you want it to follow the default track's language instead?

## What you need to do

1. Sign in and change the password.
2. **Sources → Auto-align**: to align subtitles in a different language, choose Claude or Qwen (OpenAI-compatible, URL `https://dashscope.aliyuncs.com/compatible-mode/v1`, model e.g. `qwen-plus`), enter the key, and press "Test model".
3. **Sources**: enter the TMDB key and the Assrt token, and press "Test" once for each.
4. Find a **Blender Foundation open movie** (e.g. Tears of Steel, Sintel) to try the whole flow. The development and testing rules forbid me from downloading copyrighted films from YTS; that step is your call.

## About selling it

This is not legal advice. The core of this system is finding films on YTS and downloading them with BitTorrent. Most content on YTS is unlicensed, and downloading also uploads at the same time. Selling such a product or service carries clear legal risk for both you and the buyers:

- In Taiwan this falls under copyright law, and a platform provider may also be found to be contributing to infringement.
- On licensing: ffmpeg is Debian's build, which includes GPL components. Distributing the image requires providing source code under the GPL. The other main packages are MIT-licensed (Whisper, faster-whisper, ffsubsync, WebTorrent).
- The subtitle sources each have their own terms of use too.

To commercialize, I suggest talking to a lawyer first, and considering replacing the film source with licensed content.

## Suggestions (not done, worth doing)

- All four suggestions have been done (see the update at the top).
- In noisy stretches where recognition hears nothing, it could listen to a few more windows nearby and align again (currently the window positions are fixed).
