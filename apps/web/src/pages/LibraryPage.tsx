import type { LibraryItem } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Banner, Chip, ConfirmInline, Empty, PageHead, Skeleton } from '../components/Bits';
import { FillPage, ScrollList } from '../components/FillPage';
import { Poster } from '../components/Poster';
import { useToast } from '../components/Toasts';
import { t } from '../copy/zh-TW';
import { del } from '../lib/api';
import { bytes, percent, versionLabel } from '../lib/format';
import { keys, useLibrary, useMe } from '../lib/queries';

type Filter = keyof typeof t.library.filters;
const FILTERS: Filter[] = ['all', 'nosub', 'draft', 'export', 'exported'];

/** docs/11-pages.md, "片庫": the filters are done here, from the counts the list carries. */
export function matches(f: Filter, i: LibraryItem): boolean {
  switch (f) {
    case 'nosub':
      return i.subtitles.total === 0;
    case 'draft':
      return i.subtitles.draft > 0 && i.subtitles.confirmed === 0;
    case 'export':
      return i.subtitles.confirmed > 0 && i.exports === 0;
    case 'exported':
      return i.exports > 0;
    default:
      return true;
  }
}

const NEXT_TAB: Record<LibraryItem['next'], string> = {
  subtitles: 'subtitles',
  sync: 'sync',
  export: 'export',
  exported: 'export',
};

export function LibraryPage() {
  const lib = useLibrary();
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter');
  const filter: Filter = FILTERS.includes(raw as Filter) ? (raw as Filter) : 'all';
  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('filter');
    else next.set('filter', f);
    setParams(next, { replace: true });
  };
  const items = lib.data ?? [];
  const shown = items.filter((i) => matches(filter, i));
  return (
    <FillPage>
      <PageHead title={t.library.title} lead={t.library.lead} />
      {lib.isError ? (
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => lib.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      ) : !lib.data ? (
        <Skeleton lines={4} />
      ) : items.length === 0 ? (
        <Empty title={t.library.empty} hint={t.library.emptyHint}>
          <Link className="btn" to="/search">
            {t.pages.toSearch}
          </Link>
        </Empty>
      ) : (
        <>
          <fieldset className="fchips">
            <legend className="sr-only">{t.library.filterLabel}</legend>
            {FILTERS.map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                {t.library.filters[f]} <span className="mono">{items.filter((i) => matches(f, i)).length}</span>
              </button>
            ))}
          </fieldset>
          {shown.length === 0 ? (
            <Empty title={t.library.filterEmpty} hint={t.library.filterEmptyHint} />
          ) : (
            <ScrollList label={t.library.title}>
              <div className="libs">
                {shown.map((item) => (
                  <Card key={item.torrent.id} item={item} />
                ))}
              </div>
            </ScrollList>
          )}
        </>
      )}
    </FillPage>
  );
}

function Card({ item }: { item: LibraryItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const x = item.torrent;
  const m = x.media;
  const others = x.holders.filter((h) => h.id !== me?.user.id).map((h) => h.displayName);
  const preview = m?.previewBytes ?? 0;
  const base = `/library/${x.id}`;
  const subs = item.subtitles;

  const remove = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await del(`/api/torrents/${x.id}/hold`);
      toast(t.library.removed);
      void qc.invalidateQueries({ queryKey: keys.library });
      void qc.invalidateQueries({ queryKey: keys.storage });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  const converting = m && !m.directPlay && (m.proxy.state === 'pending' || m.proxy.state === 'running');

  return (
    <article className="lib" id={x.id}>
      <Poster
        url={x.movie.posterUrl}
        title={x.movie.title}
        year={x.movie.year}
        runtimeMin={x.movie.runtimeMin}
        size="sm"
      />
      <div className="lib-main">
        <h2>
          <Link className="link" to={`${base}/${NEXT_TAB[item.next]}`}>
            {x.movie.title}
          </Link>
        </h2>
        <span className="sub">
          {[x.movie.titleZh, String(x.movie.year), versionLabel(x.version)].filter(Boolean).join(' · ')}
        </span>
        <ol className="flow">
          <li className="done">{t.library.stepVideo}</li>
          <li className={subs.confirmed > 0 ? 'done' : subs.total > 0 ? 'part' : ''}>
            {subs.total ? t.library.stepSubs(subs.confirmed, subs.draft) : t.library.stepSubsNone}
          </li>
          <li className={item.exports > 0 ? 'done' : ''}>
            {item.exports ? t.library.stepExported(item.exports) : t.library.stepNotExported}
          </li>
        </ol>
        {others.length > 0 && <span className="sub">{t.library.sharedWith(others.join('、'))}</span>}
        {x.status === 'analyzing' && (
          <span className="sub">
            <Chip tone="info">{t.library.analyzing}</Chip> {t.library.analyzingNote}
          </span>
        )}
        {converting && m && <span className="sub">{t.library.previewRunning(percent(m.proxy.progress))}</span>}
        {confirm && (
          <ConfirmInline
            text={
              others.length
                ? t.library.confirmShared(others.join('、'))
                : t.library.confirmLast(bytes(x.diskBytes), preview > 0 ? bytes(preview) : null)
            }
            confirmLabel={t.library.removeButton}
            busy={busy}
            onConfirm={remove}
            onCancel={() => setConfirm(false)}
          />
        )}
        {failed && <Banner tone="bad">{t.common.unknownError}</Banner>}
      </div>
      <div className="lib-act">
        <Link className="btn strong" to={`${base}/${NEXT_TAB[item.next]}`}>
          {t.library.next[item.next]}
        </Link>
        <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
          {t.library.remove}
        </button>
      </div>
    </article>
  );
}
