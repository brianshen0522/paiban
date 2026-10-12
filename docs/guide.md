# User guide: one run-through in five minutes

From finding a film to getting an MKV file with synced subtitles in it.

## 1. Find a film and download it

1. After signing in you are on the **Search** page. Type a title (Chinese or English both work), or filter by genre, year or rating.
2. Click a film to open its **film page**, which lists the versions you can download (resolution, source, file size).
   - Versions marked "Plays in the browser" won't need converting later when you sync subtitles, and save the most space.
   - Versions someone has already downloaded are marked; just press "Add to my library" and it won't be downloaded again.
3. Press "Download". Watch the progress on the **Downloads** page: Queued, Downloading, Done. You can pause and resume.

When there isn't enough space, it tells you how much is missing and takes you to the **Storage** page to see what can be deleted. The system never deletes any files on its own.

## 2. Wait for it to be ready

When the download finishes, the system automatically:

- Analyzes the audio: draws the waveform and finds where people are talking (within about a minute).
- Runs speech recognition: listens to a few parts of the film and notes what was said, for auto-align later (about 1 to 3 minutes per film).
- For versions the browser can't play directly, makes a separate small preview file.

You can see the progress of all of these in the film's workspace, and you don't have to wait for them to finish before looking for subtitles.

## 3. Find subtitles

Go to **Library** and click the film's "Subtitles".

1. Choose languages (Traditional Chinese, Simplified Chinese, English) and press "Search all sources". Results from every subtitle source are listed together; ones marked "Matches the YTS release" come from the same release as the version you downloaded and usually sync best.
2. Not sure which to pick? Press "Auto-align and rank all": each one is auto-aligned once and scored, and the best is marked "Recommended".
3. Press "Add". Simplified Chinese subtitles are converted to Traditional automatically.
4. If you already have a subtitle file, upload it under "Upload your own" (SRT, ASS, VTT, or a ZIP, 7z or RAR containing them).

## 4. Line up the subtitles

Press "Sync" next to the added subtitles to open the **sync workbench**.

1. First press "**Auto-align**" (shortcut A). The system compares what is said in the film with each line of the subtitles, and finds the overall offset, speed difference (different frame rates), and breakpoints caused by different cuts. After a few seconds it is applied, and the message bar says how far things moved and how the score changed.
2. Press "Checkpoints" and listen to a few lines one by one: if it's right press "This one is right"; if not, fix it with the tools below.
   - "Snap to speech": fine-tunes within 1.5 seconds before and after the current position.
   - Offset and rate: move a whole segment together.
   - Anchors: drag a line to where it really starts; pin two or more and the speed is worked out too.
   - If a single line is off on its own, you can edit that line's time or text directly.
3. Every step can be undone with "Undo". When you're happy, press "**Confirm sync**", and these subtitles are ready for export.

The score is "the share of subtitle time that overlaps speech", and is only a hint; in the end, your ears decide.

## 5. Export MKV

The film's "Export":

1. Tick the subtitles to put in (several are fine, e.g. Chinese plus English), and choose one as the default.
2. You can change the file name. Press "Start export".
3. When it's done, press "Download". The video and audio aren't re-encoded; the subtitle tracks are just added, so it's fast and the quality is unchanged.

## Other

- **Profile**: change your display name, password, appearance (Light, Dark, System) and the subtitle languages to search by default, and see the devices you've signed in on and sign them out.
- **Notifications** (the bell in the top-right corner): a download finished or failed, an export finished, someone else synced the subtitles of a film you share.
- Several people can use the same film together. If someone else happens to be editing while you sync subtitles, you're told when you save and can choose whose version to keep.
- Remove films you don't want from Library or the Storage page. If others still hold it, it's only taken out of your library, and the files stay for them.
