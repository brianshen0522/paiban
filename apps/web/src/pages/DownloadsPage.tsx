import type { Me, Torrent } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { Banner, Chip, ConfirmInline, Empty, PageHead, Progress, Skeleton, type Tone } from '../components/Bits';
import { FillPage, ScrollList } from '../components/FillPage';
import { Poster } from '../components/Poster';
import { SpaceShort } from '../components/SpaceShort';
import { useToast } from '../components/Toasts';
import { t } from '../copy/zh-TW';
import { ApiFailure, del, post } from '../lib/api';
import { bytes, eta, percent, relative, speed, versionLabel } from '../lib/format';
import { keys, useTorrents } from '../lib/queries';

const TONE: Record<Torrent['status'], Tone> = {
  queued: '',
  downloading: 'info',
  paused: 'warn',
  analyzing: 'info',
  ready: 'ok',
  failed: 'bad',
};

/** docs/11-pages.md, "下載". */
export function DownloadsPage() {
  const me = useOutletContext<Me>();
  const isAdmin = me.user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const showAll = isAdmin && params.get('all') === '1';
  const list = useTorrents(showAll ? 'all' : 'mine');

  const toggleAll = (on: boolean) => {
    const next = new URLSearchParams(params);
    if (on) next.set('all', '1');
    else next.delete('all');
    setParams(next, { replace: true });
  };

  const items = list.data ?? [];
  const active = items.filter((x) => x.status === 'downloading' || x.status === 'queued' || x.status === 'paused');
  active.sort((a, b) => rank(a) - rank(b) || (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const failed = items.filter((x) => x.status === 'failed');
  const done = items
    .filter((x) => x.status === 'ready' || x.status === 'analyzing')
    .sort((a, b) => Date.parse(b.completedAt ?? '') - Date.parse(a.completedAt ?? ''))
    .slice(0, 6);

  return (
    <FillPage>
      <PageHead title={t.downloads.title}>
        {isAdmin && (
          <label className="chk">
            <input type="checkbox" checked={showAll} onChange={(e) => toggleAll(e.target.checked)} />
            {t.downloads.showAll}
          </label>
        )}
      </PageHead>
      {list.isError ? (
        <Banner tone="bad">
          <span>
            {list.error instanceof ApiFailure && list.error.code === 'NETWORK'
              ? t.common.offline
              : t.common.unknownError}
          </span>
          <button type="button" onClick={() => list.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      ) : !list.data ? (
        <Skeleton lines={4} />
      ) : items.length === 0 ? (
        <Empty title={t.downloads.empty} hint={t.downloads.emptyHint}>
          <Link className="btn" to="/search">
            {t.pages.toSearch}
          </Link>
        </Empty>
      ) : (
        <ScrollList label={t.downloads.title}>
          <section className="card">
            <div className="dl-head">
              <h2>{t.downloads.active}</h2>
              {active.length > 0 && <Summary active={active} />}
            </div>
            {active.length === 0 ? (
              <p className="sub">{t.downloads.nothingActive}</p>
            ) : (
              active.map((x) => <Row key={x.id} x={x} me={me} showHolders={showAll} />)
            )}
          </section>
          {failed.length > 0 && (
            <section className="card">
              <h2>{t.downloads.problems}</h2>
              {failed.map((x) => (
                <Row key={x.id} x={x} me={me} showHolders={showAll} />
              ))}
            </section>
          )}
          {done.length > 0 && (
            <section className="card">
              <h2>{t.downloads.recent}</h2>
              {done.map((x) => (
                <Row key={x.id} x={x} me={me} showHolders={showAll} />
              ))}
              <p className="sub dl-more">
                {t.downloads.moreDone}{' '}
                <Link className="link" to="/library">
                  {t.downloads.toLibrary}
                </Link>
              </p>
            </section>
          )}
        </ScrollList>
      )}
    </FillPage>
  );
}

/** "1 GB / 2.4 GB": what has arrived of the whole. */
const sizeOf = (x: Torrent) => t.downloads.sizeOf(bytes(x.downloadedBytes), bytes(x.sizeBytes));

/**
 * One line over the list (Brian, 2026-10-06, "優化下載頁面"): how many are downloading, waiting
 * and paused, the speed of all of them together and when the last one should be done.
 */
function Summary({ active }: { active: Torrent[] }) {
  const n = (s: Torrent['status']) => active.filter((x) => x.status === s).length;
  const running = active.filter((x) => x.status === 'downloading');
  const total = running.reduce((a, x) => a + x.speedBps, 0);
  const left = active.reduce((a, x) => a + Math.max(0, x.sizeBytes - x.downloadedBytes), 0);
  // Only downloads that are moving have a finish time; the slowest of them is "all done".
  const etas = running.map((x) => x.etaSeconds).filter((s): s is number => s !== null && Number.isFinite(s));
  const last = etas.length === running.length && running.length > 0 ? Math.max(...etas) : null;
  const parts = [
    n('downloading') ? t.downloads.summary.downloading(n('downloading')) : null,
    n('queued') ? t.downloads.summary.queued(n('queued')) : null,
    n('paused') ? t.downloads.summary.paused(n('paused')) : null,
  ].filter(Boolean);
  return (
    <p className="dl-sum">
      <span>{parts.join(' · ')}</span>
      {total > 0 && <b className="mono">{t.downloads.summary.speed(speed(total))}</b>}
      {left > 0 && <span className="mono">{t.downloads.summary.left(bytes(left))}</span>}
      {last !== null && <span>{t.downloads.summary.eta(Math.round(last / 60))}</span>}
    </p>
  );
}

const rank = (x: Torrent) => (x.status === 'downloading' ? 0 : x.status === 'paused' ? 1 : 2);

function meta(x: Torrent, me: Me): string {
  const pct = percent(x.progress);
  switch (x.status) {
    case 'downloading':
      if (x.progress === 0 && x.peers === 0) return t.downloads.findingPeers;
      return t.downloads.downloadingMeta(pct, sizeOf(x), speed(x.speedBps), x.peers, eta(x.etaSeconds));
    case 'paused':
      return t.downloads.pausedMeta(pct, sizeOf(x));
    case 'queued':
      return x.queuePosition
        ? t.downloads.queuedMeta(x.queuePosition, me.limits.maxActiveDownloads, bytes(x.sizeBytes))
        : t.downloads.queuedWaiting;
    case 'analyzing':
      return t.downloads.analyzingMeta;
    case 'failed': {
      const reason = x.error ? t.downloads.errors[x.error.code] : t.common.unknownError;
      return x.diskBytes > 0 ? t.downloads.failedMeta(reason, bytes(x.diskBytes)) : t.downloads.failedNothing(reason);
    }
    default: {
      const done = x.completedAt ? t.downloads.doneMeta(relative(x.completedAt)) : '';
      return [done, previewMeta(x)].filter(Boolean).join(' · ');
    }
  }
}

/** docs/11-pages.md, "下載": the preview's state on a finished row; nothing for a film that plays directly. */
function previewMeta(x: Torrent): string {
  const m = x.media;
  if (!m || m.directPlay) return '';
  if (m.proxy.state === 'ready') return t.downloads.previewReady;
  if (m.proxy.state === 'pending' || m.proxy.state === 'running')
    return t.downloads.previewRunning(percent(m.proxy.progress));
  return t.downloads.previewMissing;
}

type Confirm = 'cancel' | 'remove' | null;

function Row({ x, me, showHolders }: { x: Torrent; me: Me; showHolders: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const shared = x.holders.length > 1;

  const run = async (fn: () => Promise<unknown>, after?: (r: unknown) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      after?.(r);
      void qc.invalidateQueries({ queryKey: ['torrents'] });
      void qc.invalidateQueries({ queryKey: keys.storage });
    } catch (err) {
      setError(err instanceof ApiFailure ? err : new ApiFailure('INTERNAL', 500, 'unexpected'));
      void qc.invalidateQueries({ queryKey: ['torrents'] });
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  const leave = () =>
    run(
      () => del<{ deleted: boolean }>(`/api/torrents/${x.id}/hold`),
      (r) => toast((r as { deleted: boolean }).deleted ? t.downloads.removed : t.downloads.removedShared),
    );

  const actions = !x.mine ? (
    <span className="sub">{t.downloads.onlyView}</span>
  ) : (
    <>
      {x.status === 'downloading' && (
        <button type="button" disabled={busy} onClick={() => run(() => post(`/api/torrents/${x.id}/pause`))}>
          {t.downloads.pause}
        </button>
      )}
      {x.status === 'paused' && (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            run(
              () => post<Torrent>(`/api/torrents/${x.id}/resume`),
              () => {
                // Resuming goes to the back of the queue; say so only when it has to wait.
                const others = (qc.getQueryData<Torrent[]>(keys.torrents('mine')) ?? []).filter(
                  (y) => y.id !== x.id && y.status === 'downloading',
                ).length;
                if (others >= me.limits.maxActiveDownloads) toast(t.downloads.resumedQueued);
              },
            )
          }
        >
          {t.downloads.resume}
        </button>
      )}
      {x.status === 'failed' && (
        <button
          type="button"
          className="strong"
          disabled={busy}
          onClick={() =>
            run(
              () => post(`/api/torrents/${x.id}/retry`),
              () => toast(t.downloads.retried),
            )
          }
        >
          {t.downloads.retry}
        </button>
      )}
      {(x.status === 'downloading' || x.status === 'paused' || x.status === 'queued') && (
        <button type="button" disabled={busy} aria-expanded={confirm === 'cancel'} onClick={() => setConfirm('cancel')}>
          {t.downloads.cancel}
        </button>
      )}
      {x.status === 'failed' && (
        <button type="button" disabled={busy} aria-expanded={confirm === 'remove'} onClick={() => setConfirm('remove')}>
          {t.downloads.remove}
        </button>
      )}
      {(x.status === 'ready' || x.status === 'analyzing') && (
        <Link className="btn" to={`/library/${x.id}/subtitles`}>
          {t.downloads.open}
        </Link>
      )}
    </>
  );
  const detail = x.status !== 'ready' && x.status !== 'analyzing' && (
    <Link
      className="btn dl-detail"
      to={`/downloads/${x.id}`}
      aria-label={t.downloads.detailLabel(x.movie.titleZh ?? x.movie.title)}
    >
      {t.downloads.detail} ›
    </Link>
  );

  return (
    <div className="dl">
      <Link to={`/downloads/${x.id}`} className="dl-poster" tabIndex={-1} aria-hidden="true">
        <Poster
          url={x.movie.posterUrl}
          title={x.movie.title}
          year={x.movie.year}
          runtimeMin={x.movie.runtimeMin}
          size="sm"
        />
      </Link>
      <div className="dl-main">
        <div>
          <Link
            to={`/downloads/${x.id}`}
            className="dl-title"
            aria-label={t.downloadDetail.openDetail(x.movie.titleZh ?? x.movie.title)}
          >
            <b>{x.movie.titleZh ?? x.movie.title}</b>
          </Link>{' '}
          <span className="sub-i">{versionLabel(x.version)}</span>
        </div>
        {(x.status === 'downloading' || x.status === 'paused' || x.status === 'failed') && (
          <Progress
            value={x.progress}
            bad={x.status === 'failed'}
            live={x.status === 'downloading' && x.speedBps > 0}
            label={`${x.movie.title} ${percent(x.progress)}%`}
          />
        )}
        <span className="dl-meta">{meta(x, me)}</span>
        {showHolders && (
          <span className="sub">{t.downloads.holders(x.holders.map((h) => h.displayName).join('、'))}</span>
        )}
      </div>
      <div className="dl-act">
        <Chip tone={TONE[x.status]}>{t.downloads.status[x.status]}</Chip>
        {actions}
        {detail}
      </div>
      {confirm && (
        <div className="dl-confirm">
          <ConfirmInline
            text={
              confirm === 'remove'
                ? t.downloads.confirmRemove(bytes(x.diskBytes))
                : shared
                  ? t.downloads.confirmCancelShared
                  : t.downloads.confirmCancel
            }
            confirmLabel={confirm === 'remove' ? t.downloads.remove : t.downloads.cancel}
            busy={busy}
            onConfirm={leave}
            onCancel={() => setConfirm(null)}
          />
        </div>
      )}
      {error && (
        <div className="dl-confirm">
          {error.code === 'STORAGE_LIMIT' || error.code === 'DISK_FULL' ? (
            <SpaceShort error={error} retry onClose={() => setError(null)} />
          ) : (
            <Banner tone="bad">
              <span>{t.errors[error.code as keyof typeof t.errors] ?? t.common.unknownError}</span>
              <button type="button" onClick={() => setError(null)}>
                {t.common.gotIt}
              </button>
            </Banner>
          )}
        </div>
      )}
    </div>
  );
}
