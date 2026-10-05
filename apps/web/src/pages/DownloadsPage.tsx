import type { Me, Torrent } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { Banner, Chip, ConfirmInline, Empty, PageHead, Progress, Skeleton, type Tone } from '../components/Bits';
import { Thumb } from '../components/Poster';
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
    <>
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
        <>
          <section className="card">
            <h2>{t.downloads.active}</h2>
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
            </section>
          )}
        </>
      )}
    </>
  );
}

const rank = (x: Torrent) => (x.status === 'downloading' ? 0 : x.status === 'paused' ? 1 : 2);

function meta(x: Torrent, me: Me): string {
  const pct = percent(x.progress);
  switch (x.status) {
    case 'downloading':
      if (x.progress === 0 && x.peers === 0) return t.downloads.findingPeers;
      return t.downloads.downloadingMeta(pct, speed(x.speedBps), x.peers, eta(x.etaSeconds));
    case 'paused':
      return t.downloads.pausedMeta(pct);
    case 'queued':
      return x.queuePosition
        ? t.downloads.queuedMeta(x.queuePosition, me.limits.maxActiveDownloads)
        : t.downloads.queuedWaiting;
    case 'analyzing':
      return t.downloads.analyzingMeta;
    case 'failed': {
      const reason = x.error ? t.downloads.errors[x.error.code] : t.common.unknownError;
      return x.diskBytes > 0 ? t.downloads.failedMeta(reason, bytes(x.diskBytes)) : t.downloads.failedNothing(reason);
    }
    default:
      return x.completedAt ? t.downloads.doneMeta(relative(x.completedAt)) : '';
  }
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
        <Link className="btn" to="/library">
          {t.downloads.open}
        </Link>
      )}
    </>
  );

  return (
    <div className="dl">
      <Thumb title={x.movie.title} year={x.movie.year} />
      <div className="dl-main">
        <div>
          <b>{x.movie.title}</b> <span className="sub-i">{versionLabel(x.version)}</span>
        </div>
        {(x.status === 'downloading' || x.status === 'paused' || x.status === 'failed') && (
          <Progress value={x.progress} bad={x.status === 'failed'} label={`${x.movie.title} ${percent(x.progress)}%`} />
        )}
        <span className="dl-meta">{meta(x, me)}</span>
        {showHolders && (
          <span className="sub">{t.downloads.holders(x.holders.map((h) => h.displayName).join('、'))}</span>
        )}
      </div>
      <div className="dl-act">
        <Chip tone={TONE[x.status]}>{t.downloads.status[x.status]}</Chip>
        {actions}
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
