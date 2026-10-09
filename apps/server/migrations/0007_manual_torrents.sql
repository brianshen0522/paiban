-- Torrents added by hand (Brian, 2026-10-09; D26 changed): a magnet link or a .torrent file, with the
-- film picked on TMDB. Such a film may have no YTS id; only its largest video file is downloaded.
alter table movies alter column yts_id drop not null;
create unique index movies_tmdb_manual on movies (tmdb_id) where yts_id is null;

alter table torrents add column origin text not null default 'yts' check (origin in ('yts', 'manual'));
alter table torrents add column metainfo bytea;
alter table torrents add column trackers text[] not null default '{}';

-- A magnet link or .torrent file someone is about to add: the torrent service fetches a magnet's
-- metadata from the swarm; a .torrent file carries it. Rows, not files; nothing under /data.
create table torrent_inspections (
  id          uuid primary key default gen_random_uuid(),
  created_by  uuid references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  source      text not null check (source in ('magnet', 'file')),
  info_hash   text not null check (info_hash ~ '^[0-9a-f]{40}$'),
  trackers    text[] not null default '{}',
  state       text not null default 'pending' check (state in ('pending', 'ready', 'failed')),
  error_code  text,
  metainfo    bytea,
  finished_at timestamptz
);
create index torrent_inspections_pending on torrent_inspections (created_at) where state = 'pending';
