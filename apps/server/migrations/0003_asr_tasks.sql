-- Speech recognition shows up among the background tasks (docs/11-pages.md, "系統狀態").
alter table tasks drop constraint tasks_kind_check;
alter table tasks add constraint tasks_kind_check check (kind in ('analyze', 'asr', 'preview', 'align', 'rank', 'export', 'rescan'));
