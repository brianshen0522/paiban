# 09 Sync workbench

This is the most important page in the whole product (D6): this is where people line up subtitles, entirely in the browser.

**The prototype is the behavioral basis for this page.** `prototype/workbench/index.html` is a workbench you can actually operate (using a 92-second demo clip), and the "Sync" tab in `prototype/platform/index.html` is how it looks embedded in the platform. This document turns the prototype's behavior into rules and adds what the prototype lacks and the real version needs. Where the two conflict, this document wins.

The logic is in `packages/shared/src/sync-core/core.ts` (17 tests); the prototype's UI code is in `prototype/workbench/src/ui.js`.

## How people use it

A five-step guide is fixed at the top of the screen:

1. Play and see how far off the subtitles are
2. Press "Auto-align"
3. Listen to a few lines with checkpoints
4. Fine-tune if anything is off
5. Confirm sync

Most subtitles are done after steps 1, 2, 3 and 5; only a few need step 4. The interface's job is to keep this path obvious at all times, while offering enough manual tools when they're needed.

## Layout

Desktop (see `prototype/platform/screenshots/09-sync.png`):

(Changed by Brian, 2026-10-06: the tools used to sit below the timeline, so listening to checkpoints meant scrolling down to press "This one is right" and back up to watch the video. Now the tool in use is right below the video.)

```
┌ Step guide ──────────── film info, save state, status, [Confirm sync] ┐
│  Video (subtitles overlaid)               │  Subtitle lines           │
│  Play, ±1 s, time, speed, second language │  Search, [Sync|Edit lines]│
│  Message bar (what just happened, result) │  (same height as the left │
│  [Auto-align|Checkpoints|Offset and rate| │   column; the list        │
│   Anchors and segments|Compare and undo]  │   scrolls inside it)      │
│   ← one tool at a time                    │                           │
├ Sync score, zoom, follow playback ─────────────────────────────────────┤
│  Whole-film overview                                                   │
│  Timeline: ticks, waveform, speech, subtitle blocks, checkpoints,      │
│            anchors, playback position                                  │
├ Summary after confirming ──────────────────────────────────────────────┤
└ Keyboard shortcuts (collapsed) ────────────────────────────────────────┘
```

- The video is at most the window height minus 600 px (at least 240 px) tall, letterboxed inside that. That way, on a 1920 × 1080 screen, the video, play bar, message bar and tools are all visible as soon as the page opens; on shorter screens, after scrolling down once.
- The tools are a set of tabs, one shown at a time. On first open it's "Auto-align"; for subtitles that have already been aligned (segments aren't the default) or are confirmed, it's "Checkpoints". After auto-align succeeds, and on pressing "Listen to next" or a checkpoint (including the N shortcut), it switches to "Checkpoints" automatically. The "Checkpoints" tab label shows "passed/total". The left and right arrow keys move between tabs (they don't seek the video).
- "Checkpoints" tab: "Listen to next", the numbered dots, "This one is right" and "This one is off" sit in one row, with a line below explaining how to use them.

The topmost row is the workbench's own header: on the left the step guide; on the right this film's info (runtime, codec, frame rate, line count, e.g. "01:52:10 · H.264 · 23.976 fps · 1,204 lines"), the save state, the status tag ("Draft" or "Confirmed") and "Confirm sync". Which subtitles to sync isn't chosen here; it's chosen in the card above the workbench ([11-pages.md](11-pages.md), "Sync (09)").

Below the timeline is a row of legend items: Waveform, Detected speech, Subtitles (segment 1), Subtitles (segment 2), and finally "Drag left or right on the subtitle row to move the subtitles".

Mobile (400 px): everything stacks vertically: video, play bar, message bar, tool tabs, subtitle lines, timeline. The tool tabs are one row that swipes sideways. No horizontal scrollbar may appear.

The workspace header also shrinks on the Sync tab: the poster becomes a 44 px wide thumbnail; the subtitle-picker card is one row (menu, status, preview note, speech recognition status), with a second row only when there is a warning or progress bar.

## Loading

On entering this page, fetch in parallel:

| Data | Endpoint | Used for |
| --- | --- | --- |
| Subtitles, line list, sync doc | `GET /api/subtitles/:id` | |
| Media status and sources | `GET /api/media/:id` | Deciding which file to play |
| Waveform | `GET /api/media/:id/peaks` | Timeline |
| Speech | `GET /api/media/:id/speech` | Timeline, score, snapping |
| Second subtitles (if chosen) | `GET /api/subtitles/:id` | Shown alongside |

The waveform and speech are optional, and independent of each other:

| Situation | Workbench |
| --- | --- |
| Both present | All features |
| Waveform only (speech detection failed) | Timeline has the waveform, but no speech band, score, colored dots, snapping or auto-align |
| Neither (analysis failed, no audio track, or not done yet) | Same as above, and no waveform |

Controls that can't be used are disabled with the reason given (based on the code in `MediaStatus.errors.analysis`), with "Analyze again" next to them. While analysis is still running, show "Analyzing the audio. The waveform appears here when it is done.", and fill it in when the completion event arrives, with no reload needed. The prototype's demo clip always has a waveform and speech, so all the wording in this section is new.

When `analysis` is `none` (automatic analysis is off and nobody has asked for it yet), the frontend calls `POST /api/media/:id/analyze` once when the workspace opens.

## Which file to play

`MediaStatus.sources` is already sorted by priority; the frontend uses the first one in order:

| Situation | Source | Screen |
| --- | --- | --- |
| Plays directly (H.264 plus AAC in MP4; the test WebM counts too) | Original file | Normal |
| Doesn't play directly, preview file ready | Preview file | Normal. The note at the top of the Sync tab says the preview file is in use and its timing is exactly the same as the original (wording in [11-pages.md](11-pages.md), "Sync (09)") |
| Doesn't play directly, preview file not ready, audio file ready | Audio file | **Audio-only mode**: the video area shows the title, the "Audio only" tag, and why there's no picture (Brian, 2026-10-10: the tag alone looked broken): while converting, "The browser can't play this version directly; the preview video is converting (12%). Until it's done you can sync subtitles by sound, and you'll be told when you can switch." plus a progress bar; when nothing is converting, "Browsers can't play this version directly, so there's only sound. To see the picture, press "Make preview file"." Subtitles are still overlaid and every other feature is the same. The top shows the preview file's progress, and when it's ready offers to switch (no automatic switch, so as not to interrupt work) |
| Nothing ready yet | None | Show progress; the subtitle lines and timeline can be viewed, but nothing plays |

When the preview video is neither being made nor done (automatic conversion off, not enough space at the time, failed before, or deleted by an administrator), show the "Make preview file" button and the space needed (`MediaStatus.previewNeedBytes`). Pressing it calls `POST /api/media/:id/proxy`; when space is short, say next to the button how much is missing and link to the Storage page. When `MediaStatus.errors.proxy` is `PREVIEW_NO_SPACE`, explain the cause first: "There was not enough space when the download finished, so no preview file was made." (The prototype has no such button; this wording is new.)

When `<video>` fails to load (`error` event), fall back to the next source; if all fail, show an error and keep the list and timeline. The prototype's "silent timer" exists only so the prototype can demo in environments that can't play video; the real version doesn't need it.

### Time

- The only clock is the media element's `currentTime`.
- Subtitle display uses `requestVideoFrameCallback` (when available) to match the actual frame; otherwise `requestAnimationFrame`. Audio-only mode uses `requestAnimationFrame`.
- The timeline and overview redraw in the same loop, and only when the time or state has changed.

## Sync doc

Type `SyncDoc` (`packages/shared/src/sync-core/core.ts`):

```ts
{
  v: 1,
  segments:    [{ from, scale, offset }],              // from is a line index; the first segment's from is always 0; ascending by from
  edits:       { [line id]: { dStart?, dEnd?, text?, deleted? } },
  anchors:     [{ cue, t }],                           // cue is a line index: "the line at index cue is at t seconds"
  checkpoints: [{ cue, status: 'todo' | 'ok' | 'bad' }]   // cue is an index too
}
```

A line's final time:

```
start = original start × its segment's scale + that segment's offset + (dStart in edits, or 0)
end   = original end   × its segment's scale + that segment's offset + (dEnd   in edits, or 0)
end is at least 0.2 seconds after start
```

A few design points:

- **The original subtitles are never changed.** Every adjustment is recorded in the sync doc, so you can always go back to the original.
- **Per-line edits store deltas**, not absolute times. So when the whole segment is shifted later, lines adjusted individually move along with it instead of staying put.
- `segments`, `anchors` and `checkpoints` use the line's **index** (its position, starting from 0); only `edits` uses the line's **id** (`Cue.id`) as the key. After normalization the two map in a fixed way (id = index + 1), but code must not assume that; always keep them distinct. "Line n" shown in the interface is the index plus 1.
- Times are all rounded to milliseconds before storing.

A doc where "nothing has been touched" is `identityDoc()`: one segment, `scale` 1, `offset` 0. That's what subtitles are when first added, unless they were already aligned during ranking.

## Features

Each item lists the prototype's behavior. Message bar text follows the prototype (the contents of `say(…)` in `ui.js`).

### Playback

| Control | Behavior |
| --- | --- |
| Play / Pause | Button text changes accordingly. Space |
| −1 s / +1 s | ← →; with Shift, 5 seconds |
| Time | `00:00:00,000 / total length`, monospace font |
| Speed | 0.5×, 0.75×, 1×, 1.25×, 1.5× |
| Second language | See "Showing other subtitles alongside" |

### Subtitle lines

- Each row: number, start time (click to jump to that line), text, and a colored dot showing how much the line overlaps speech (50% or more green, 25% or more yellow, below that red).
- The line currently playing is marked, and during playback the list scrolls to it automatically (not while the user is working in the list).
- The selected line expands a row of actions.
- The search box filters text as you type, case-insensitive; when second subtitles are shown alongside, their text counts too (in the prototype every line carries both languages, so it always searches both). When nothing matches, show "No lines contain "…"."
- **A film has over a thousand lines, so the list must be virtualized** (TanStack Virtual). The prototype has only 26 lines and doesn't do this.
- ↑ ↓ select the previous and next line.

Two modes, via the toggle button above the list:

| Mode | Actions on the selected line | Dragging a subtitle block on the timeline |
| --- | --- | --- |
| **Sync** (default) | Play this line, Anchor to now, Start a segment here | Moves the whole segment's offset |
| **Edit lines** | Text input; −50, +50 and Set to now for both start and end; Delete this line / Restore this line; Play this line | Moves only that line |

"Play this line" plays from 1 second before the line starts to 0.4 seconds after it ends, then stops.

Deleted lines are struck through in the list, not drawn on the timeline and left out of exports; numbering is redone on export. This is for removing ad lines and credits.

### Timeline

Drawn on a canvas, top to bottom: time ticks, waveform, speech band, subtitle blocks, checkpoints (above the blocks), anchors (below the blocks), plus a playback position line.

- A subtitle block's color depends on which segment it belongs to (three colors in rotation); the selected line has a thick border; the line currently playing is brighter; blocks overlapping speech by less than 25% have a red line along the bottom.
- When a block is wide enough it shows its number, and when wider still, its text.
- Segment boundaries get a dashed line labeled "segment n".
- **Pressing and dragging sideways on the subtitle block row**:
  - Sync mode: moves a whole segment's offset. Pressing on a block moves the segment that block belongs to; pressing in the gap between blocks moves the segment of the selected line.
  - Edit lines mode: pressing on a block moves only that line; pressing in a gap moves the whole segment, as in sync mode.
  - Movement is in 10 ms steps. On release, the message bar reports the result: "Offset after dragging is −2.36 s. Sync score 80%." or "Line 14 moved to 01:23.456."
- **Pressing and dragging anywhere else**: moves the playback position.
- **Clicking without dragging**: jumps to that time; clicking on a block also selects that line.
- Only movement of 3 pixels or more counts as a drag, so a click doesn't move things by accident.
- Zoom out, zoom in (by a factor of two each time), whole film. Zoom is centered on the playback position. The minimum view is 8 seconds.
- "Follow playback": checked by default. When checked, during playback and when the view isn't the whole film, if the playback position leaves the view or passes 85% of it, the view scrolls once; after scrolling the playback position sits at 20% of the view.

The **overview** sits above the timeline: a thin strip thumbnail of the whole film showing speech, and each subtitle line colored by overlap. It lets the user see at a glance situations like "the first half is right, the second half is off". It outlines the timeline's current view; clicking or dragging jumps there.

Drawing long films: each pixel draws only the min and max of the waveform in the range it covers; only subtitle blocks within the view are drawn. A two-hour film must stay smooth at whole-film view.

### Auto-align

- An "Auto-align" button with an "Allow segments" checkbox next to it (checked by default). Shortcut A. Below this group is a line of explanation: "Auto-align tries all common frame rates and whole-film offsets; snap to speech only fine-tunes within 1.5 seconds of the current position."
- Calls `POST /api/subtitles/:id/auto-align`, usually 1 to 5 seconds, during which the button shows it's in progress.
- The returned segments **replace** the current `segments`, all anchors are cleared, and all checkpoints go back to "not heard yet". Per-line edits are kept.
- The message bar reports the result, e.g. "Auto-align done: offset −2.36 s. Sync score 51% → 80%. Next, listen to a few lines with checkpoints to check." When there are segments, each is listed.
- When `agree` is false, one more sentence: "The two alignment methods disagree. Listen to a few more checkpoints." (new)
- When it fails (`ALIGN_FAILED`), the doc is untouched and the message bar says: "Auto-align didn't work. Try again, or align by hand with anchors." (new)
- This is an undoable action. The save right after applying it carries `reason: 'auto-align'`.

The prototype computes it right in the browser; the real version hands it to the server, for reasons given in [08-media-pipeline.md](08-media-pipeline.md).

### Align by other subtitles (new)

- When the same film has other subtitles, the "Automatic" group gets one more row: a "By other subtitles" menu (confirmed ones first; each entry shows language, confirmed or draft, and release name) and an "Align to these" button. A line of explanation sits below the menu; when a draft is picked it instead says "These subtitles aren't confirmed yet; if they are off, aligning to them will be off too."
- Calls `POST /api/subtitles/:id/auto-align` with `referenceId`. It doesn't need speech data, so it can be pressed before the film's analysis is done. How it's computed: see [08-media-pipeline.md](08-media-pipeline.md), "Align by other subtitles".
- It applies the same way as auto-align (replaces segments, clears anchors, checkpoints go back to not heard yet, undoable). The message bar also says how it was aligned: for the same language, "Matched N pairs with the English subtitles' text; this result fits M of them."; for different languages, "The two subtitles are in different languages, so this aligned only by when each English line appears."
- If the reference subtitles are off, the result is off too. So when the server has speech data, it also checks the reference subtitles themselves (`reference.offBy`, see 08); when they're more than 1 second away from the film's speech, one more sentence is added: "Note: the English subtitles themselves are about 23.7 seconds off from the speech in the film and may not be synced; this result will be off by as much. Listen to a few checkpoints first; if it's wrong, press "Undo" and use "Auto-align" instead, or sync the English subtitles first." (This really happened in QA: subtitles marked confirmed that were actually 23.7 seconds late were used as the reference.)
- When the result has `extraLines`, the message bar says "Lines 1 and 2 have no match in the other subtitles; they look like opening or closing credits." and offers a "Delete these N lines" button: it deletes those lines in one step, and Undo brings them back. If it isn't pressed, nothing is deleted.

### Snap to speech

Within 1.5 seconds either side of the current segment's existing offset, find the position that best fits speech (`bestLinear`, rate unchanged). Computed in the browser. If the difference is under 5 ms, say "Already lined up with speech. Nothing moved."

Purpose: after the user has dragged it roughly into place by hand, let the system finish the job.

### Offset and rate

The scope is **the segment containing the selected line**; with only one segment, that's the whole film. A small tag next to the title shows the scope ("Whole film" or "Segment 2, lines 14–26").

- Buttons for −500, −50, +50 and +500 ms. Shortcuts `,` `.` (50) and Shift plus `,` `.` (500).
- A field where seconds can be typed directly. When the input isn't a number, say "Enter the offset in seconds, e.g. -2.4."
- A rate drop-down listing the known ratios:

  | Option | Ratio |
  | --- | --- |
  | Unchanged | 1 |
  | Subtitles 25 fps → video 23.976 | 25 / 23.976 |
  | Subtitles 23.976 → video 25 fps | 23.976 / 25 |
  | Subtitles 24 fps → video 23.976 | 24 / 23.976 |
  | Subtitles 23.976 → video 24 fps | 23.976 / 24 |
  | Subtitles 25 fps → video 24 | 25 / 24 |
  | Subtitles 24 fps → video 25 | 24 / 25 |

  In the menu, every option except "Unchanged" is followed by its ratio, e.g. "Subtitles 25 fps → video 23.976 (×1.0427)". When the current rate isn't in the list (computed from anchors), there's an extra "Custom (×1.0432)".
- **When the rate changes, the selected line stays where it is** (the offset is recomputed with it as the pivot), so the view doesn't jump away.

Offsets are written differently from the general rules in [17-ui.md](17-ui.md) in two places: in the input field it's a plain number (`-2.36`, ASCII minus sign, no unit, because it has to be editable); in the summary after confirming it has three decimals (`−2.360 s`), because that's the exact stored value. Everywhere else (message bar, segment labels) it's two decimals plus the unit.

Changing the offset or rate clears that segment's anchors.

### Anchors

"Anchor the selected line to now" (shortcut Enter): pause the moment someone starts a line, select that line, and press it.

- 1 anchor in the segment: it determines only the offset.
- 2 or more: least squares computes rate and offset together (`fitAnchors`). If the computed rate is within 0.002 of a known ratio, that ratio is used; outside the 0.9 to 1.1 range it's rejected.
- Pressing it again on the same line updates that line's anchor.
- Anchors are drawn on the timeline as small triangles below the subtitle blocks.
- The explanation below changes with the count: "Pause the moment someone starts a line, select that line, then press "Anchor to now"." → "This segment has 1 anchor. Anchor another line far from it to work out the rate too." → "This segment has n anchors; the rate is worked out from them."

This is the main manual tool when auto-align fails. When the gap is over 60 seconds (beyond auto-align's search range), it's also the fastest method: one anchor pulls the whole segment back. Typing the offset directly or dragging works too, but you have to work out the difference yourself.

### Segments

Subtitles for a different cut need different offsets in different parts.

- "Start a segment at the selected line": starts a new segment from that line, initially keeping the original segment's offset and rate. If line 1 or a line that already starts a segment is selected, explain and do nothing.
- "Merge into the previous segment": shown only when there are two or more segments and the selected line isn't in the first. After merging, the previous segment's offset and rate are used.
- When there are two or more segments, the tool area lists each segment's range and offset.
- There is no limit on the number of segments.

### Checkpoints

The system picks a few lines spread across the film, each preceded by a clear pause (`pickCheckpoints`), and asks the user to listen to them. The count is `Me.limits.checkpointCount`, default 8 (D36). They're picked when the subtitles are added and stored in the sync doc.

- "Listen to next" (shortcut N): jumps to the next checkpoint that hasn't passed, plays from 1.5 seconds before the line to 0.5 seconds after, then stops. Message bar: "Checkpoint 2/8: line 14. Listen for whether it appears the moment someone speaks."
- "This one is right": marks it passed and jumps to the next automatically. When all have passed, say "All checkpoints are confirmed. You can press "Confirm sync"."
- "This one is off": marks it off and suggests adjusting with offset, snap or "Anchor to now", then listening again.
- Pressing either button with no checkpoint being listened to: "Press "Listen to next" first, then mark it."
- A row of numbered dots shows each checkpoint's state; clicking one jumps straight to listening to it. They're drawn on the timeline too.
- **Any action that changes timing sends checkpoints within the affected range back to "not heard yet"**: changing a segment's offset or rate affects that segment; auto-align and merging affect all; changing a single line affects that line. If something you've heard changes, it has to be heard again.

### Compare and undo

- "Hold to see original timing" (hold O): while held, the screen, list and timeline all show the subtitles' original timing, and an "Original timing" tag appears on the video; release to return. Used to check "how much have I actually improved it".
- Undo / Redo (Z / Shift+Z): keeps the last 100 steps. Each step is a snapshot of the whole doc. Continuous typing counts as one step (from starting to type until leaving the input); one drag counts as one step.
- "Reset all": goes back to the original subtitles and picks checkpoints again. It can itself be undone.

Undo history lives only in the browser and is gone when you leave the page.

### Confirm

"Confirm sync":

1. If some checkpoints haven't passed, ask first: "n checkpoints haven't been confirmed yet.", offering "Confirm anyway" (focused), "Listen to next checkpoint" and "Not now" (Esc works too). This question **appears right below the button**, not in the message bar: the message bar is below the timeline, out of sight from the button, so pressing it would seem to do nothing (reported by Brian, 2026-10-06). A failed confirm is also reported below the button.
2. Make sure the latest doc is saved first, then call `POST /api/subtitles/:id/confirm`.
3. Status changes from "Draft" to "Confirmed". A summary appears below: sync score, number of checkpoints passed, how many lines were edited and deleted, each segment's line range, rate and offset; plus "Download subtitle file" and "Go to Export".
4. This film's other holders get a notification: "Brian synced the Traditional Chinese subtitles for Charade".

After confirming, any change to timing or text (segments, offset, rate, per-line edits, deleting lines) immediately sets the status back to "Draft", collapses the summary, and requires confirming again before exporting. Merely re-marking a checkpoint doesn't: that doesn't change the subtitles themselves. This is decided on the server (`PUT /api/subtitles/:id/doc` compares `segments` and `edits`), and the frontend shows the `status` from the response.

### Showing other subtitles alongside

Check "Also show" and pick another subtitle track for this film (e.g. English subtitles underneath while syncing Chinese ones). In the prototype this is a "Chinese-English bilingual" checkbox; "Also show" and the menu next to it are new. For the matching item on the Profile page, the prototype says "Show Chinese-English bilingual on the Sync page by default" and the real version says "Show a second language on the Sync tab by default". The second track uses its own sync doc for timing, is shown in smaller text below the main subtitles, and adds a line in the list too. It's for reference only and can't be edited here. The user preference "Show a second language on the Sync tab by default" decides whether it's on by default (choosing English when there are English subtitles).

In the prototype every line carries both a Chinese and an English line; that's just the form of the demo data (D35).

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| Space | Play or pause |
| ← → | Back or forward 1 second; with Shift, 5 seconds |
| `,` `.` | Subtitles 50 ms earlier or later; with Shift, 500 |
| ↑ ↓ | Select the previous or next line |
| Enter | Anchor the selected line to now |
| A | Auto-align |
| N | Listen to the next checkpoint |
| O (hold) | See original timing |
| Z | Undo; with Shift, redo |

Shortcuts don't work while focus is in an input, drop-down or text area. When focus is on a button, Space and Enter go to the button. They don't work while Ctrl, Cmd or Alt is held.

### Message bar

Below the play bar and above the tools is a line of text, updated after every action, saying what just happened, what the numbers became, and what to do next. It's `aria-live="polite"`, so screen readers read it too. Some messages carry buttons (e.g. the question before confirming).

This line is the workbench's main way of "teaching people how to use it"; don't reduce it to a toast.

## Saving

The prototype has no concept of saving; all wording in this section and the next subsection is new.

- As soon as the doc changes, it saves automatically 1.5 seconds later (`PUT /api/subtitles/:id/doc`, with the current `rev`). Continued actions restart the timer.
- When this save includes "applying the auto-align result" or "Reset all", it carries `reason` (`auto-align` or `reset`), and the server keeps an extra history copy. Other saves don't carry it.
- Next to the status tag, show "Saved", "Saving…" or "Not saved".
- Before leaving the page or switching subtitles, save any unsaved changes first. When the browser is closing, warn with `beforeunload`.
- When saving fails (network problem), keep the changes, show "Save failed. Retrying automatically", and retry every 5 seconds.

### Two people editing at once

Subtitles are shared by all of this film's holders, so someone else may be editing at the same time.

- When the server answers a save with `REVISION_CONFLICT`, someone else saved first. Stop autosaving and show: "Meiling just changed these subtitles too." (the name comes from `details.updatedBy`). Two choices:
  - "Use their version": loads the doc from the server and puts your own changes into the undo history (so Undo can still bring them back).
  - "Overwrite with mine": saves again with the new `rev`.
- When an event that someone else saved (`subtitle`, whose `by` is the person who saved) arrives while there are no unsaved changes: fetch again, swap in the new doc directly, and say in the message bar who changed it.

No real-time collaboration (seeing the other person's cursor and so on).

## ASS subtitles

The first version treats ASS as a plain-text list of lines (D34): styles, positioning and effects are stripped on import, and syncing and exporting work the same as SRT. The subtitle lines show "Originally ASS; styling removed" (new).

How a later "keep ASS styling" feature would work (not done now, but the data model already allows for it): the sync doc depends only on line indexes and ids, so the same doc can be applied to the original ASS `Dialogue` lines, rewriting start and end times and outputting the rest unchanged; preview overlays it on the video with JASSUB (the WebAssembly build of libass); packing uses ASS for the subtitle track. The original `.ass` file is already kept at `/data/subtitles/<id>/original.ass`.

## Accessibility

- Every feature can be done with the keyboard alone. Dragging on the timeline has keyboard equivalents (offset buttons and shortcuts, ↑ ↓ to select lines).
- The canvas has `role="img"` and a description; the information it conveys is available as text in the list and message bar.
- Color is never the only signal: the colored dots have a `title` ("62% overlap with speech"), and the checkpoint dots have an `aria-label`.
- Respect `prefers-reduced-motion`: scrolling isn't animated.

## Differences from the prototype

| Prototype | Real version |
| --- | --- |
| The header has a "What's wrong with these subtitles" drop-down that switches between three demo scenarios; the left side shows the demo clip's info | No such menu. The left of the header shows this film's real info; which subtitles to sync is chosen in the card above the workbench |
| Auto-align searches ±30 seconds | 60 seconds ([08-media-pipeline.md](08-media-pipeline.md) explains why) |
| After confirming, re-marking a checkpoint, undo and redo all go back to draft | Only real changes to timing or text go back to draft (undo or redo that restores different segments or per-line edits counts, of course) |
| Auto-align is computed in the browser | Computed on the server (two methods); the browser only does snapping and anchors |
| 5 checkpoints; the copy hard-codes the number (step guide "Listen to five lines with checkpoints", message "All five checkpoints are confirmed…") | 8 by default, count from `Me.limits.checkpointCount`; the copy has no number: "Listen to a few lines with checkpoints", "All checkpoints are confirmed. You can press "Confirm sync"." |
| Every line carries Chinese and English | Showing other subtitles alongside |
| The subtitle list renders everything | Virtualized |
| The summary after confirming shows the full SRT and "Copy subtitle text" | Changed to "Download subtitle file". The full SRT is too long and isn't shown |
| Uses a silent timer when the video fails to load | Falls back to the next source; if all fail, shows an error |
| No concept of saving | Autosave, revision conflict handling |
| No audio-only mode | Has one |
| In the platform prototype, editing after confirming still shows the "Confirmed" tag (a prototype simplification); the standalone workbench prototype goes back to draft | Changing timing or text goes back to draft |
| `core.js`'s `toSrt` doesn't sort or guarantee a minimum length per line; `pickCheckpoints` picks the same line repeatedly when there are fewer lines than checkpoints | `packages/shared/src/sync-core/core.ts` wins: `toSrt` sorts by start time with each line at least 0.2 seconds; `pickCheckpoints` picks at most as many as there are lines, without repeats. These differences are intentional |

## Acceptance

`prototype/workbench/e2e.cjs` is the prototype's automated check (all 40 items pass). Rewrite it as the project's Playwright tests, using the clip in `fixtures/` and the three mistimed subtitle files. A few items are tied to things only the prototype has and must be done differently, not copied over:

| Prototype check | Real version |
| --- | --- |
| Switching demo scenarios with the menu at the top (`scenario switch resets status`) | No such menu. Load different subtitles instead |
| Reading results from the full SRT on screen (`srt output is retimed`, numbering after deleting a line) | Download `GET /api/subtitles/:id/file?synced=true` and compare instead |
| "5 checkpoints", "all 5 marked right" | The count is 8 (or the value set for the test) |
| The English line each cue carries (`bilingual overlay`) | Showing other subtitles alongside instead |
| Reading `zh` in `edits` after line editing (the prototype's field name) | The field is `text` |
| Calling `Core.toSrt` directly, jumping to a time and reading internal state via `window.__bench` | Design your own test hooks (existing only in the test build); read from the screen whatever can be read from the screen |

The real version must pass all the remaining behavior:

- The "2.4 seconds late" subtitles start at a 51% score; after auto-align the offset is about −2.36 and the score 80%; line 2 is shown at 6.0 seconds.
- Pressing confirm with checkpoints not yet heard asks the question; after marking all as right, confirming succeeds, the status becomes confirmed and the summary has the offset.
- The "different frame rate" subtitles start at 66%; after auto-align the rate is ×1.0427 and the score 80%.
- Placing one anchor each on lines 2 and 25 by hand gives the same rate as auto-align (×1.0427); the offset is −0.834 (auto-align's is −0.79; the difference is within tolerance).
- The "different cut" subtitles are two segments at 80% after auto-align; only 62% without segments allowed; after undo, back to two segments.
- Four −500 ms presses give −2.00; another −500 from the keyboard gives −2.50; after snapping, back to about −2.36.
- Typing −2.4 directly in the offset field: score 80%.
- Dragging 60 pixels on the timeline changes the offset by the seconds 60 pixels correspond to.
- Splitting and merging segments by hand.
- While holding to see original timing the tag appears, and disappears on release.
- Searching "電梯" ("elevator") leaves one row; searching for a word that doesn't exist shows the empty state.
- Edit lines: after changing text the screen updates; start time +50 ms; after deleting a line the export has one line fewer with continuous numbering.
- After zooming in twice, the view is a quarter of the total length.
- No horizontal scrollbar at 400 px wide; dark mode works.

Plus what the prototype doesn't have: autosave, state surviving a reload, both choices for a revision conflict, audio-only mode, smooth scrolling of a list with over a thousand lines.

Don't rely on whether the test Chromium can decode H.264 (see 15-testing.md), so tests use `fixtures/clip.webm` (a VP9 version of the same clip). The WebM's audio was re-encoded, so speech detection differs very slightly from `clip.mp4` (28 of 9,242 frames differ), and the score may be off by 1 percentage point (e.g. 79% instead of 80%); offset and rate are unaffected. Tests run on the WebM allow ±1 percentage point when comparing scores.
