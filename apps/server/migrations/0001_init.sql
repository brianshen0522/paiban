-- Paiban reference schema. PostgreSQL 16 or newer, no extensions.
--
-- This file is the reference for tables, constraints and the storage accounting. The project
-- keeps its real schema as Drizzle definitions with generated migrations; columns, checks and
-- indexes must stay equivalent to what is written here (docs/03-data-model.md explains each table).
-- The job queue (pg-boss) creates and owns its own schema, "pgboss"; nothing here touches it.
--
-- Two rules shape this schema:
--   1. Nothing a person put on disk is ever deleted by a timer. There is no expires-then-purge
--      column on any table that owns files.
--   2. Every byte that counts toward the limit is a column here, so "how full are we" is one
--      query (the storage_usage view) and admission can be decided inside one transaction
--      (storage_admit).

-- ------------------------------------------------------------------ people

create table users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null unique check (username = lower(username) and username ~ '^[a-z0-9_]{3,32}$'),
  display_name  text not null check (char_length(display_name) between 1 and 20),
  password_hash text not null,                         -- argon2id, PHC string
  role          text not null default 'member' check (role in ('admin', 'member')),
  disabled      boolean not null default false,
  prefs         jsonb not null default '{}'::jsonb,    -- UserPrefs in packages/shared/src/contracts/api.ts
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

create table sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  token_hash   bytea not null unique,                  -- sha256 of the cookie value; the value itself is never stored
  user_agent   text not null default '',               -- as sent at sign-in; the device list derives os and browser from it when read
  ip           inet,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null                    -- expired rows are ignored at lookup; no job removes them
);
create index sessions_user on sessions (user_id);

create table invites (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  role       text not null check (role in ('admin', 'member')),
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_by    uuid references users (id) on delete set null,
  used_at    timestamptz
);

create table password_resets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  token_hash bytea not null unique,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

-- ------------------------------------------------------------------ configuration

create table settings (
  key        text primary key,                         -- 'storage.limitBytes', 'downloads.maxActive', ... (docs/13-settings.md)
  value      jsonb not null,
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);

create table secrets (
  name       text primary key check (name in ('tmdbKey', 'subdlKey', 'assrtToken')),
  nonce      bytea not null,
  ciphertext bytea not null,                           -- AES-256-GCM with the key from SECRET_KEY; never returned by the API
  updated_by uuid references users (id) on delete set null,
  updated_at timestamptz not null default now()
);

-- What our own parsers made of answers from YTS, TMDB and the subtitle sources. Never the raw
-- response: a raw response can carry someone else's key (docs/07-subtitle-providers.md), the
-- parsed form cannot. A row is overwritten in place when it is fetched again after expires_at;
-- nothing sweeps this table.
create table provider_cache (
  provider   text not null,
  cache_key  text not null,
  payload    jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (provider, cache_key)
);

-- The latest thing known about each outside source, from a test or from ordinary use
-- (SourceHealth in packages/shared/src/contracts/api.ts). One row per source, overwritten each time.
create table source_health (
  source     text primary key check (source in ('yts', 'tmdb', 'justsubtitles', 'subdl', 'yify', 'assrt')),
  state      text not null check (state in ('ok', 'warn', 'down')),
  code       text not null,                            -- SourceCheckCode
  data       jsonb not null default '{}'::jsonb,       -- numbers and names for the sentence; never a key
  checked_at timestamptz not null default now()
);

-- Pacing of requests to one outside source, shared by every process that talks to it (the API
-- searches, the media worker downloads). provider_take_slot() hands out send times that are at
-- least the given interval apart; the caller sleeps until the returned time, then sends.
create table provider_slots (
  provider text primary key,
  next_at  timestamptz not null
);

create function provider_take_slot(p_provider text, p_interval_ms integer) returns timestamptz
language sql as $$
  insert into provider_slots as s (provider, next_at)
  values (p_provider, clock_timestamp())
  on conflict (provider) do update
    set next_at = greatest(s.next_at + make_interval(secs => p_interval_ms / 1000.0), clock_timestamp())
  returning next_at
$$;

-- ------------------------------------------------------------------ films and downloads

-- Only films that someone has downloaded. Search results are not stored.
create table movies (
  id          uuid primary key default gen_random_uuid(),
  yts_id      integer not null unique,
  imdb_code   text not null,
  tmdb_id     integer,
  title       text not null,
  title_zh    text,
  year        integer not null,
  runtime_min integer not null default 0,
  rating      numeric(3, 1),
  genres      text[] not null default '{}',
  summary     text not null default '',
  language    text,
  poster_path text,                                    -- cached copy under /data/posters; too small to count toward the limit
  fetched_at  timestamptz not null default now()
);

create table torrents (
  id                    uuid primary key default gen_random_uuid(),
  info_hash             text not null unique check (info_hash ~ '^[0-9a-f]{40}$'),
  movie_id              uuid not null references movies (id),
  quality               text not null,
  source_type           text not null default '',
  video_codec           text not null default '',
  bit_depth             integer not null default 8,
  audio_channels        text not null default '',
  size_bytes            bigint not null check (size_bytes > 0),  -- as YTS lists it; what admission used
  length_bytes          bigint,                                   -- from the torrent's own metadata, once known

  -- `state` is written by the torrent worker (the API sets 'queued' on create and on retry).
  -- `want` is written by the API. The worker makes state follow want. See docs/06-torrent-worker.md.
  -- A row whose want is 'remove' is on its way out: every endpoint treats it as gone.
  state                 text not null default 'queued' check (state in ('queued', 'downloading', 'paused', 'completed', 'failed')),
  want                  text not null default 'run' check (want in ('run', 'pause', 'remove')),
  phase                 text check (phase in ('metadata', 'data', 'verifying')),
  progress              real not null default 0 check (progress >= 0 and progress <= 1),
  downloaded_bytes      bigint not null default 0,
  uploaded_bytes        bigint not null default 0,                -- keeps growing after completion while seeding
  download_bps          integer not null default 0,
  peers                 integer not null default 0,
  seeding               boolean not null default false,
  bitfield              bytea,                                    -- which pieces are on disk, for fast resume
  clean_stop            boolean not null default false,           -- the bitfield is trusted only after a clean stop
  error_code            text,                                     -- TorrentErrorCode in packages/shared/src/contracts/api.ts
  error_message         text,                                     -- English, for logs and the administrator; never shown as is

  -- Storage accounting. While not completed the row counts size + preview reservation;
  -- failed rows count what is actually left on disk; completed rows count the measured size.
  -- The preview plan is frozen when the download is admitted: later changes to the settings
  -- apply to downloads admitted after them, never to this row.
  preview_reserve_bytes bigint not null default 0 check (preview_reserve_bytes >= 0),
  preview_proxy_res     text check (preview_proxy_res in ('480p', '720p')),  -- null = no preview video planned
  disk_bytes            bigint not null default 0 check (disk_bytes >= 0),

  requested_by          uuid references users (id) on delete set null,
  queued_at             timestamptz not null default now(),
  started_at            timestamptz,
  last_progress_at      timestamptz,
  completed_at          timestamptz,
  last_used_at          timestamptz                               -- workspace opened or export created; written at most once an hour
);
create index torrents_state on torrents (state, queued_at);
create index torrents_movie on torrents (movie_id);

-- Who has this film in their library. One copy on disk no matter how many holders.
-- A torrent with no holders can exist only after its last holder's account was removed;
-- an administrator deletes it by hand.
create table torrent_holders (
  torrent_id uuid not null references torrents (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  added_at   timestamptz not null default now(),
  primary key (torrent_id, user_id)
);
create index torrent_holders_user on torrent_holders (user_id);

-- The main video file of a completed torrent and everything derived from it.
create table media_files (
  id             uuid primary key default gen_random_uuid(),
  torrent_id     uuid not null unique references torrents (id) on delete cascade,
  rel_path       text not null,                        -- inside /data/torrents/<info_hash>/
  size_bytes     bigint not null,
  duration_s     double precision,
  container      text,
  video_codec    text,
  pix_fmt        text,
  width          integer,
  height         integer,
  fps_num        integer,
  fps_den        integer,
  audio_codec    text,
  audio_channels integer,
  -- Browsers play it as is: MP4 with H.264 8-bit 4:2:0 and AAC or MP3, or WebM with VP8, VP9 or
  -- AV1 (8-bit 4:2:0) and Opus or Vorbis. Predicted from YTS data, settled by ffprobe.
  direct_play    boolean not null default false,
  -- Probing (ffprobe, under a second) always happens once the download is complete; it settles
  -- direct_play, the duration and the preview plan. It has its own state so that it can be
  -- claimed like any other job and so that a file ffprobe cannot read is not tried forever.
  probe_state    text not null default 'pending' check (probe_state in ('pending', 'running', 'ready', 'failed')),
  probe          jsonb,

  -- Waveform and speech detection. 'none' = not requested yet (automatic analysis is switched
  -- off and nobody has opened the film).
  analysis_state text not null default 'pending' check (analysis_state in ('none', 'pending', 'running', 'ready', 'failed')),
  analysis_bytes bigint not null default 0,            -- probe.json + peaks.bin + ref.npz + speech.json
  audio_state    text not null default 'none' check (audio_state in ('none', 'pending', 'running', 'ready', 'failed')),
  audio_bytes    bigint not null default 0,
  proxy_state    text not null default 'none' check (proxy_state in ('none', 'pending', 'running', 'ready', 'failed')),
  proxy_res      text check (proxy_res in ('480p', '720p')),
  proxy_progress real not null default 0,
  proxy_bytes    bigint not null default 0,
  reserve_bytes  bigint not null default 0 check (reserve_bytes >= 0),  -- still reserved for preview assets not finished yet
  error          jsonb,                                -- {asset, code}: the latest failure, cleared when that asset is requested again
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------------ subtitles

-- One row per source per film: where the last search stands.
create table subtitle_searches (
  torrent_id    uuid not null references torrents (id) on delete cascade,
  provider      text not null check (provider in ('justsubtitles', 'yify', 'assrt')),
  state         text not null check (state in ('running', 'ok', 'error')),
  result_count  integer not null default 0,
  error_code    text,
  retry_at      timestamptz,
  languages     text[] not null default '{}',
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  primary key (torrent_id, provider)
);

-- Search hits and uploads that have not been added yet. A new search replaces the rows of that
-- source that were never fetched; rows whose file was downloaded stay until a person removes them.
-- An upload is a row from the moment the file arrives (fetch_state 'fetching'), so a file that
-- cannot be read shows up as a failed row with its reason instead of vanishing.
create table subtitle_candidates (
  id                uuid primary key default gen_random_uuid(),
  torrent_id        uuid not null references torrents (id) on delete cascade,
  provider          text not null check (provider in ('justsubtitles', 'yify', 'assrt', 'upload')),
  provider_ref      text not null,                     -- the source's own id; for uploads, sha256 of the file
  language_label    text not null default '',
  language          text not null default 'und',       -- guess before download, detection after
  release_name      text not null default '',
  uploader          text,
  page_url          text,
  download_url      text,                              -- stored with its query string removed; never holds a key
  flags             jsonb not null default '{}'::jsonb, -- Candidate.flags, plus `rating` (the source's own score, used only for ordering)
  fetch_state       text not null default 'new' check (fetch_state in ('new', 'fetching', 'ready', 'failed')),
  fetch_started_at  timestamptz,                       -- when it became 'fetching'; a row stuck there for 10 minutes is marked failed
  fetch_error       text check (fetch_error in ('DOWNLOAD_FAILED', 'ARCHIVE_INVALID', 'NO_SUBTITLE', 'PARSE_FAILED')),
  rel_dir           text,                              -- /data/subtitles/candidates/<id>/ once fetched
  bytes             bigint not null default 0,
  detected_encoding text,
  cue_count         integer,
  align_state       text not null default 'none' check (align_state in ('none', 'queued', 'running', 'done', 'failed')),
  align_score       real,
  align_result      jsonb,                             -- AlignResult in packages/shared/src/contracts/api.ts
  created_by        uuid references users (id) on delete set null,
  created_at        timestamptz not null default now(),
  unique (torrent_id, provider, provider_ref)
);

-- Subtitles added to a film. Shared by everyone who holds the film.
create table subtitles (
  id             uuid primary key default gen_random_uuid(),
  torrent_id     uuid not null references torrents (id) on delete cascade,
  provider       text not null check (provider in ('justsubtitles', 'yify', 'assrt', 'upload')),
  provider_ref   text,
  release_name   text not null default '',
  language       text not null,
  format         text not null check (format in ('srt', 'ass', 'vtt')),  -- of the original file; .ssa counts as 'ass'
  original_encoding text,
  converted_s2t  boolean not null default false,
  cue_count      integer not null check (cue_count > 0),
  -- /data/subtitles/<id>/ : original.<ext> (the bytes as received), cues.json (the list everything
  -- uses), and cues.original.json (the list before Simplified-to-Traditional conversion, only
  -- when it was converted)
  rel_dir        text not null,
  bytes          bigint not null default 0,
  sha256         text not null,                        -- of cues.json, to refuse a second copy of the same subtitle
  status         text not null default 'draft' check (status in ('draft', 'confirmed')),
  score          real,
  doc            jsonb not null,                       -- SyncDoc
  doc_rev        integer not null default 0,
  added_by       uuid references users (id) on delete set null,
  added_at       timestamptz not null default now(),
  updated_by     uuid references users (id) on delete set null,
  updated_at     timestamptz not null default now(),
  confirmed_by   uuid references users (id) on delete set null,
  confirmed_at   timestamptz,
  unique (torrent_id, sha256)
);
create index subtitles_torrent on subtitles (torrent_id);

-- A snapshot each time a sync document is confirmed, replaced by auto-align, or reset.
create table subtitle_revisions (
  id          bigint generated always as identity primary key,
  subtitle_id uuid not null references subtitles (id) on delete cascade,
  rev         integer not null,
  doc         jsonb not null,
  reason      text not null check (reason in ('confirm', 'auto-align', 'reset')),
  author      uuid references users (id) on delete set null,
  created_at  timestamptz not null default now()
);
create index subtitle_revisions_subtitle on subtitle_revisions (subtitle_id, rev);

-- ------------------------------------------------------------------ exports

-- Exported MKV files outlive the film they were made from: torrent_id becomes null.
create table exports (
  id               uuid primary key default gen_random_uuid(),
  torrent_id       uuid references torrents (id) on delete set null,
  movie_title      text not null,
  version_label    text not null,                      -- "1080p BluRay x264": kept because the torrent row may go away
  file_name        text not null check (file_name ~* '\.mkv$' and file_name !~ '[\\/:*?"<>|]' and char_length(file_name) <= 200),
  tracks           jsonb not null,                     -- [{subtitleId, rev, language, title, isDefault}]
  state            text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed')),
  progress         real not null default 0,
  reserved_bytes   bigint not null default 0 check (reserved_bytes >= 0),  -- counts while queued or running
  size_bytes       bigint not null default 0 check (size_bytes >= 0),      -- counts once done
  rel_path         text,                               -- /data/exports/<id>/<file_name>
  error_code       text,                               -- ExportErrorCode in packages/shared/src/contracts/api.ts
  cancel_requested boolean not null default false,
  created_by       uuid references users (id) on delete set null,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index exports_torrent on exports (torrent_id);
create index exports_creator on exports (created_by);

-- ------------------------------------------------------------------ activity

create table notifications (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references users (id) on delete cascade,
  kind       text not null,
  data       jsonb not null default '{}'::jsonb,
  link       jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user on notifications (user_id, id desc);

create table audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor_id   uuid references users (id) on delete set null,
  actor_name text not null default '',                 -- kept so the line still reads after the account is gone
  action     text not null,                            -- stable code such as 'admin.storage.limit' (docs/12-auth.md); the UI owns the wording
  target     jsonb not null default '{}'::jsonb,       -- what it was done to, as data: {movieTitle, version}, {name, role}, ...
  detail     jsonb not null default '{}'::jsonb,       -- anything else worth keeping; never a secret
  ip         inet
);
create index audit_log_actor on audit_log (actor_id, id desc);

-- Background work people can see on the system page. pg-boss decides when jobs run; this table
-- is what the UI reads, what a retry starts from, and how a job hands its answer back to the API.
create table tasks (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('analyze', 'preview', 'align', 'rank', 'export', 'rescan')),
  torrent_id  uuid references torrents (id) on delete set null,
  subject     jsonb not null default '{}'::jsonb,       -- what the UI needs to name it: {movieTitle, version, language, fileName}
  input       jsonb not null default '{}'::jsonb,       -- ids and options the job was started with; never subtitle text
  state       text not null default 'queued' check (state in ('queued', 'running', 'done', 'failed', 'cancelled')),
  progress    real not null default 0,
  result      jsonb,                                    -- the job's answer (AlignResult, rescan summary), read by the API after NOTIFY
  error_code  text,
  attempts    integer not null default 0,
  created_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index tasks_recent on tasks (created_at desc);
create index tasks_torrent on tasks (torrent_id, kind, created_at desc);

-- What the last "recalculate usage" run found on disk and could not match to a row, and rows
-- whose files are gone. Rewritten by every run. These are notes for the administrator; nothing
-- is deleted because of them, and orphan folders do not count toward the limit (they have no row).
create table storage_findings (
  id       uuid primary key default gen_random_uuid(),
  kind     text not null check (kind in ('orphan', 'missing')),
  root     text not null check (root in ('torrents', 'media', 'subtitles', 'candidates', 'exports')),
  name     text not null check (name !~ '[/\\]' and name not in ('.', '..')),  -- one folder name directly under that root
  bytes    bigint not null default 0,
  ref_id   uuid,                                       -- for 'missing': the row whose files are gone
  subject  jsonb not null default '{}'::jsonb,         -- for 'missing': {movieTitle, fileName}, so the page can name it
  found_at timestamptz not null default now(),
  unique (kind, root, name)
);

create table service_heartbeats (
  service      text primary key check (service in ('api', 'torrent', 'media')),
  started_at   timestamptz not null,
  last_seen_at timestamptz not null,
  version      text not null default '',
  info         jsonb not null default '{}'::jsonb       -- torrent: listening port, last incoming connection
);

-- ------------------------------------------------------------------ storage accounting

-- Everything that counts toward the limit, by category. docs/10-storage.md is the prose version.
-- Posters and the files under /data/tmp are not counted.
create view storage_usage as
select
  -- finished films, their analysis data, subtitles and fetched candidates
  coalesce((select sum(disk_bytes) from torrents where state = 'completed'), 0)
    + coalesce((select sum(analysis_bytes) from media_files), 0)
    + coalesce((select sum(bytes) from subtitles), 0)
    + coalesce((select sum(bytes) from subtitle_candidates), 0)                                as movies_bytes,
  -- preview audio and video, plus what is still reserved for ones being made
  coalesce((select sum(audio_bytes + proxy_bytes + reserve_bytes) from media_files), 0)        as previews_bytes,
  -- downloads that have not finished count their full size from the moment they are admitted
  coalesce((select sum(greatest(size_bytes, coalesce(length_bytes, 0)) + preview_reserve_bytes)
            from torrents where state in ('queued', 'downloading', 'paused')), 0)              as reserved_bytes,
  -- what failed downloads left behind
  coalesce((select sum(disk_bytes) from torrents where state = 'failed'), 0)                   as partial_bytes,
  -- exports: reserved while being written, measured once done
  coalesce((select sum(case when state = 'done' then size_bytes
                            when state in ('queued', 'running') then reserved_bytes
                            else 0 end) from exports), 0)                                      as exports_bytes;

create function storage_used_bytes() returns bigint
language sql stable as $$
  select (movies_bytes + previews_bytes + reserved_bytes + partial_bytes + exports_bytes)::bigint from storage_usage
$$;

-- Admission. Call it inside the transaction that inserts or updates the row carrying the
-- reservation: the advisory lock makes concurrent requests take turns, so two downloads can
-- never both squeeze into the last free gigabyte. `release_bytes` is what the same transaction
-- is about to stop counting (a retry replaces the partial bytes with a full reservation).
-- Written for the default isolation level (READ COMMITTED): the usage query runs after the lock
-- is held and therefore sees everything committed by whoever held it before.
create function storage_admit(need_bytes bigint, release_bytes bigint default 0)
returns table (ok boolean, used_bytes bigint, limit_bytes bigint, short_bytes bigint)
language plpgsql as $$
declare
  v_used  bigint;
  v_limit bigint;
begin
  perform pg_advisory_xact_lock(727001);
  v_used := storage_used_bytes() - release_bytes;
  select (value #>> '{}')::bigint into v_limit from settings where key = 'storage.limitBytes';
  if v_limit is null then
    v_limit := 0;                                      -- no limit set means nothing may start
  end if;
  return query select v_used + need_bytes <= v_limit, v_used, v_limit, greatest(v_used + need_bytes - v_limit, 0);
end
$$;
