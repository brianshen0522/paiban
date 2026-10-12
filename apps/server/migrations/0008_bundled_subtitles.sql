-- Subtitles a download carries: files beside the film and text tracks inside it (Brian,
-- 2026-10-09; docs/08-media-pipeline.md, "Subtitles from the torrent").
alter table subtitles drop constraint subtitles_provider_check;
alter table subtitles add constraint subtitles_provider_check
  check (provider in ('justsubtitles', 'yify', 'assrt', 'upload', 'translated', 'bundled'));
