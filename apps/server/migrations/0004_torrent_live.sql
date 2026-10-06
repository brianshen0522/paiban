-- What a download is doing right now, for its detail page (docs/11-pages.md, "下載細節"). The page
-- keeps `wanted_until` a few seconds ahead while it is open; the torrent service writes `data`
-- every pass for rows still wanted. Throwaway state, so the table is unlogged.
create unlogged table torrent_live (
  torrent_id   uuid primary key references torrents (id) on delete cascade,
  wanted_until timestamptz not null,
  data         jsonb,                                  -- TorrentLive
  updated_at   timestamptz
);
