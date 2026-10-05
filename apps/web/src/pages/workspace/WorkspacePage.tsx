import type { Workspace } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Banner, Chip, Empty, Skeleton } from '../../components/Bits';
import { Thumb } from '../../components/Poster';
import { t } from '../../copy/zh-TW';
import { ApiFailure, post } from '../../lib/api';
import { versionLabel } from '../../lib/format';
import { keys, useMe, useWorkspace } from '../../lib/queries';
import { NotFoundPage } from '../StatusPages';
import { ExportTab } from './ExportTab';
import { SubtitlesTab } from './SubtitlesTab';
import { SyncTab } from './SyncTab';

export type Tab = 'subtitles' | 'sync' | 'export';
const TABS: Tab[] = ['subtitles', 'sync', 'export'];

/** docs/11-pages.md, "工作區": one film's subtitles, sync and export. */
export function WorkspacePage({ tab }: { tab: Tab }) {
  const { torrentId = '' } = useParams();
  const ws = useWorkspace(torrentId);

  if (ws.isError) {
    const e = ws.error;
    if (e instanceof ApiFailure && e.code === 'MEDIA_NOT_READY')
      return (
        <>
          <Crumbs />
          <Empty title={t.workspace.stillDownloading} hint={t.workspace.stillDownloadingHint}>
            <Link className="btn" to="/downloads">
              {t.workspace.toDownloads}
            </Link>
          </Empty>
        </>
      );
    if (e instanceof ApiFailure && (e.code === 'NOT_FOUND' || e.code === 'NOT_HOLDER' || e.status === 404))
      return <NotFoundPage />;
    return (
      <>
        <Crumbs />
        <Banner tone="bad">
          <span>{e instanceof ApiFailure && e.code === 'NETWORK' ? t.common.offline : t.common.unknownError}</span>
          <button type="button" onClick={() => ws.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      </>
    );
  }
  if (!ws.data)
    return (
      <>
        <Crumbs />
        <Skeleton lines={5} />
      </>
    );
  return <Loaded ws={ws.data} tab={tab} />;
}

function Crumbs() {
  return (
    <div className="crumbs">
      <Link className="link" to="/library">
        {t.workspace.back}
      </Link>
    </div>
  );
}

function Loaded({ ws, tab }: { ws: Workspace; tab: Tab }) {
  const me = useMe().data;
  const qc = useQueryClient();
  const navigate = useNavigate();
  const x = ws.item.torrent;
  const media = x.media;
  const others = x.holders.filter((h) => h.id !== me?.user.id).map((h) => h.displayName);

  // A film never analysed (automatic analysis off) is asked for once when its workspace opens.
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (media?.analysis !== 'none' || asked.current === media.id) return;
    asked.current = media.id;
    post(`/api/media/${media.id}/analyze`)
      .then(() => qc.invalidateQueries({ queryKey: keys.workspace(x.id) }))
      .catch(() => undefined);
  }, [media, qc, x.id]);

  const subs = ws.subtitles;
  const confirmed = subs.filter((s) => s.status === 'confirmed').length;
  const notes: Record<Tab, string> = {
    subtitles: subs.length ? t.workspace.notes.subs(subs.length) : t.workspace.notes.noSubs,
    sync: confirmed
      ? t.workspace.notes.confirmed(confirmed)
      : subs.length
        ? t.workspace.notes.unconfirmed
        : t.workspace.notes.none,
    export: ws.exports.length ? t.workspace.notes.exports(ws.exports.length) : t.workspace.notes.noExports,
  };
  const go = (to: Tab) => navigate(`/library/${x.id}/${to}`);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length] ?? tab;
    e.preventDefault();
    go(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };

  return (
    <>
      <Crumbs />
      <section className="whead">
        <Thumb title={x.movie.title} year={x.movie.year} />
        <div>
          <h1>{x.movie.title}</h1>
          <p className="sub">
            {[
              x.movie.titleZh,
              String(x.movie.year),
              versionLabel(x.version),
              others.length ? t.workspace.sharedWith(others.join('、')) : null,
            ]
              .filter(Boolean)
              .join(' · ')}{' '}
            {x.status === 'analyzing' && <Chip tone="info">{t.workspace.analyzing}</Chip>}
          </p>
        </div>
      </section>
      <div className="tabs" role="tablist" aria-label={t.workspace.tabsLabel} onKeyDown={onKey}>
        {TABS.map((k) => (
          <button
            key={k}
            id={`tab-${k}`}
            type="button"
            role="tab"
            aria-selected={tab === k}
            aria-controls="ws-panel"
            tabIndex={tab === k ? 0 : -1}
            onClick={() => go(k)}
          >
            {t.workspace.tabs[k]}
            <small>{notes[k]}</small>
          </button>
        ))}
      </div>
      <div id="ws-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="stack">
        {tab === 'subtitles' && <SubtitlesTab ws={ws} />}
        {tab === 'sync' && <SyncTab ws={ws} />}
        {tab === 'export' && <ExportTab ws={ws} />}
      </div>
    </>
  );
}
