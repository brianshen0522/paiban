-- Speech recognition for subtitle alignment (docs/08-media-pipeline.md, "語音辨識"), and the
-- language model key used to pair recognised speech with a subtitle in another language.

alter table media_files
  add column asr_state text not null default 'none' check (asr_state in ('none', 'pending', 'running', 'ready', 'failed')),
  add column asr_language text;

-- Films analysed before recognition existed get it too. This only queues work; nothing is removed.
update media_files set asr_state = 'pending' where analysis_state = 'ready';

alter table secrets drop constraint secrets_name_check;
alter table secrets add constraint secrets_name_check check (name in ('tmdbKey', 'subdlKey', 'assrtToken', 'llmKey'));
