-- Language-model profiles and subtitle translation (docs/18-llm.md, Brian 2026-10-07).

-- Profiles the api picks from for every request: by priority, then by weight; the key is sealed
-- like the other secrets, with 'llm:<id>' as associated data so it cannot be moved to another row.
create table llm_profiles (
  id             uuid primary key default gen_random_uuid(),
  name           text not null check (char_length(name) between 1 and 60),
  provider       text not null check (provider in ('openai', 'anthropic', 'azure-openai', 'azure-foundry', 'openrouter', 'self-hosted')),
  base_url       text not null default '',
  api_version    text not null default '',
  model          text not null default '',
  priority       integer not null default 1 check (priority between 1 and 9),
  weight         integer not null default 1 check (weight between 1 and 100),
  enabled        boolean not null default true,
  params         jsonb not null,                       -- LlmParams
  key_nonce      bytea,
  key_ciphertext bytea,                                -- AES-256-GCM like secrets; never returned by the API
  created_at     timestamptz not null default now(),
  updated_by     uuid references users (id) on delete set null,
  updated_at     timestamptz not null default now(),
  check ((key_nonce is null) = (key_ciphertext is null))
);

-- One row per call to a model, whatever the outcome (the page lists the latest).
create table llm_usage (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  profile_id   uuid references llm_profiles (id) on delete set null,
  profile_name text not null,
  purpose      text not null check (purpose in ('translate', 'align', 'test')),
  user_id      uuid references users (id) on delete set null,
  ok           boolean not null,
  error_code   text,                                   -- LlmErrorCode
  ms           integer not null check (ms >= 0)
);
create index llm_usage_at on llm_usage (at desc);

-- A subtitle being translated: the lines done so far are kept, so a failed or interrupted one
-- carries on where it stopped. Nothing is written to /data until it is done.
create table translations (
  id              uuid primary key default gen_random_uuid(),
  torrent_id      uuid not null references torrents (id) on delete cascade,
  source_id       uuid not null references subtitles (id) on delete cascade,
  target_language text not null check (target_language ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$'),
  mode            text not null check (mode in ('plain', 'bilingual')),
  state           text not null default 'running' check (state in ('running', 'done', 'failed', 'cancelled')),
  done_chunks     integer not null default 0 check (done_chunks >= 0),
  total_chunks    integer not null check (total_chunks > 0),
  lines           jsonb not null default '[]',         -- translated text per source line index, so far
  model           text not null default '',            -- the model that answered last, for the subtitle's name
  error_code      text,
  result_id       uuid references subtitles (id) on delete set null,
  created_by      uuid references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);
create index translations_torrent on translations (torrent_id);
create index translations_creator on translations (created_by, created_at);
create unique index translations_one_running on translations (source_id, target_language, mode) where state = 'running';

alter table subtitles drop constraint subtitles_provider_check;
alter table subtitles add constraint subtitles_provider_check
  check (provider in ('justsubtitles', 'yify', 'assrt', 'upload', 'translated'));
