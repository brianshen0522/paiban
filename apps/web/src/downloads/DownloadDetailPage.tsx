import type { Torrent, TorrentLive } from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Banner, Chip, PageHead, Skeleton } from '../components/Bits';
import { Flag } from '../components/Flag';
import { Poster } from '../components/Poster';
import { t } from '../copy/zh-TW';
import { ApiFailure, get, post } from '../lib/api';
import { bytes, eta, percent, rate, versionLabel } from '../lib/format';
import { keys } from '../lib/queries';
import { NotFoundPage } from '../pages/StatusPages';
import { countrySummary, PeerMap } from './PeerMap';
import { PieceGrid } from './PieceGrid';
import { SpeedChart } from './SpeedChart';

const TONE = {
  queued: '',
  downloading: 'info',
  paused: 'warn',
  failed: 'bad',
  analyzing: 'info',
  ready: 'ok',
} as const;
const RUNNING = new Set<Torrent['status']>(['downloading']);
const VIEWS = ['map', 'pieces', 'speed'] as const;
type View = (typeof VIEWS)[number];

/**
 * One download in detail (docs/11-pages.md, "下載細節"; Brian, 2026-10-06): where the peers are,
 * which pieces are done, how fast it goes. The live part polls every 2 seconds while the page is
 * open and the download runs; nothing is computed for downloads nobody looks at.
 */
export function DownloadDetailPage() {
  const { torrentId = '' } = useParams();
  const qc = useQueryClient();
  const torrent = useQuery({
    queryKey: [...keys.torrents('mine'), torrentId],
    queryFn: () => get<Torrent>(`/api/torrents/${torrentId}`),
    refetchInterval: 4000,
    retry: false,
  });
  const running = !!torrent.data && RUNNING.has(torrent.data.status);
  const live = useQuery({
    queryKey: ['torrent-live', torrentId],
    queryFn: () => get<TorrentLive | null>(`/api/torrents/${torrentId}/live`),
    enabled: running,
    refetchInterval: running ? 2000 : false,
    refetchIntervalInBackground: false,
  });
  const names = useMemo(() => new Intl.DisplayNames(['zh-TW'], { type: 'region' }), []);
  const [busy, setBusy] = useState(false);
  const [params, setParams] = useSearchParams();
  const view: View = (VIEWS as readonly string[]).includes(params.get('view') ?? '')
    ? (params.get('view') as View)
    : 'map';
  const show = (k: View) => setParams(k === 'map' ? {} : { view: k }, { replace: true });
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = VIEWS.indexOf(view);
    const next = VIEWS[(i + (e.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length] ?? view;
    e.preventDefault();
    show(next);
    requestAnimationFrame(() => document.getElementById(`dd-tab-${next}`)?.focus());
  };

  if (torrent.error instanceof ApiFailure && (torrent.error.status === 404 || torrent.error.status === 403))
    return <NotFoundPage />;
  if (torrent.isError)
    return (
      <Banner tone="bad">
        <span>{t.common.unknownError}</span>
        <button type="button" onClick={() => torrent.refetch()}>
          {t.common.retry}
        </button>
      </Banner>
    );
  const x = torrent.data;
  if (!x) return <Skeleton />;
  const v = live.data ?? null;

  const act = async (path: 'pause' | 'resume') => {
    setBusy(true);
    try {
      await post(`/api/torrents/${x.id}/${path}`);
      await qc.invalidateQueries({ queryKey: keys.torrents('mine') });
    } finally {
      setBusy(false);
    }
  };

  const title = x.movie.titleZh ?? x.movie.title;
  return (
    <>
      <div className="crumbs">
        <Link className="link" to="/downloads">
          {t.downloadDetail.back}
        </Link>
      </div>
      <PageHead
        title={title}
        lead={`${x.movie.titleZh ? `${x.movie.title} · ` : ''}${x.movie.year} · ${versionLabel(x.version)}`}
      />

      <section className="card dd-head">
        <Poster
          url={x.movie.posterUrl}
          title={x.movie.title}
          year={x.movie.year}
          runtimeMin={x.movie.runtimeMin}
          size="sm"
        />
        <div className="dd-main">
          <div className="dd-top">
            <span className="dd-pct mono">{percent(x.progress)}%</span>
            <Chip tone={TONE[x.status]}>{t.downloads.status[x.status]}</Chip>
          </div>
          <div
            className="dd-bar"
            role="progressbar"
            aria-valuenow={percent(x.progress)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t.downloadDetail.progressLabel}
          >
            <i style={{ width: `${percent(x.progress)}%` }} />
          </div>
          <dl className="dd-stats">
            <div>
              <dt>{t.downloadDetail.down}</dt>
              <dd className="mono">{rate(v?.downBps ?? x.speedBps)}</dd>
            </div>
            <div>
              <dt>{t.downloadDetail.up}</dt>
              <dd className="mono">{rate(v?.upBps ?? 0)}</dd>
            </div>
            <div>
              <dt>{t.downloadDetail.left}</dt>
              <dd className="mono">{x.status === 'downloading' ? eta(x.etaSeconds) : '—'}</dd>
            </div>
            <div>
              <dt>{t.downloadDetail.peers}</dt>
              <dd className="mono">{v ? v.peers.length : x.peers}</dd>
            </div>
            <div>
              <dt>{t.downloadDetail.got}</dt>
              <dd className="mono">
                {bytes(x.downloadedBytes)} / {bytes(x.sizeBytes)}
              </dd>
            </div>
          </dl>
          <div className="frow">
            {x.status === 'downloading' && (
              <button type="button" disabled={busy} onClick={() => act('pause')}>
                {t.downloads.pause}
              </button>
            )}
            {x.status === 'paused' && (
              <button type="button" disabled={busy} onClick={() => act('resume')}>
                {t.downloads.resume}
              </button>
            )}
            {(x.status === 'ready' || x.status === 'analyzing') && (
              <Link className="btn" to={`/library/${x.id}/subtitles`}>
                {t.downloads.open}
              </Link>
            )}
          </div>
        </div>
      </section>

      {!running ? (
        <Banner tone="info">
          <span>{t.downloadDetail.notRunning[x.status]}</span>
        </Banner>
      ) : !v ? (
        <section className="card">
          <p className="sub">{t.downloadDetail.connecting}</p>
          <Skeleton />
        </section>
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label={t.downloadDetail.tabsLabel} onKeyDown={onTabKey}>
            {VIEWS.map((k) => (
              <button
                key={k}
                id={`dd-tab-${k}`}
                type="button"
                role="tab"
                aria-selected={view === k}
                aria-controls="dd-panel"
                tabIndex={view === k ? 0 : -1}
                onClick={() => show(k)}
              >
                {t.downloadDetail.tabs[k]}
                <small>
                  {k === 'map'
                    ? t.downloadDetail.tabNotes.map(v.peers.length)
                    : k === 'pieces'
                      ? t.downloadDetail.tabNotes.pieces(percent(x.progress))
                      : t.downloadDetail.tabNotes.speed(rate(v.downBps))}
                </small>
              </button>
            ))}
          </div>
          <div id="dd-panel" role="tabpanel" aria-labelledby={`dd-tab-${view}`}>
            {view === 'map' && (
              <section className="card dd-map">
                <div className="dd-map-head">
                  <h2>{t.downloadDetail.mapTitle}</h2>
                  <span className="sub">
                    {v.peers.length ? countrySummary(v.peers, names) : t.downloadDetail.noPeers}
                  </span>
                </div>
                <PeerMap peers={v.peers} home={v.home} />
                <div className="pm-legend">
                  <span className="pm-key-in">{t.downloadDetail.legendIn}</span>
                  <span className="pm-key-out">{t.downloadDetail.legendOut}</span>
                  <span className="pm-key-home">{t.downloadDetail.legendHome(names.of(v.home) ?? v.home)}</span>
                  <span className="sub">{t.downloadDetail.credits}</span>
                </div>
                <PeerTable live={v} names={names} />
              </section>
            )}
            {view === 'pieces' && (
              <section className="card">
                <h2>{t.downloadDetail.piecesTitle}</h2>
                {v.pieces ? <PieceGrid pieces={v.pieces} /> : <p className="sub">{t.downloadDetail.noMetadata}</p>}
              </section>
            )}
            {view === 'speed' && (
              <section className="card">
                <h2>{t.downloadDetail.speedTitle}</h2>
                <SpeedChart history={v.history} />
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}

function PeerTable({ live, names }: { live: TorrentLive; names: Intl.DisplayNames }) {
  if (!live.peers.length) return <p className="sub">{t.downloadDetail.noPeers}</p>;
  return (
    <div className="tw">
      <table className="dd-peers rtable">
        <caption className="sr-only">{t.downloadDetail.peersCaption}</caption>
        <thead>
          <tr>
            <th>{t.downloadDetail.cols.where}</th>
            <th>{t.downloadDetail.cols.client}</th>
            <th>{t.downloadDetail.cols.link}</th>
            <th className="num">{t.downloadDetail.cols.down}</th>
            <th className="num">{t.downloadDetail.cols.up}</th>
            <th className="num">{t.downloadDetail.cols.has}</th>
          </tr>
        </thead>
        <tbody>
          {live.peers.map((p) => (
            <tr key={p.id}>
              <td className="lead">
                <Flag code={p.local ? null : p.country} />{' '}
                <span>
                  {p.local
                    ? t.downloadDetail.localNetwork
                    : p.country
                      ? (names.of(p.country) ?? p.country)
                      : t.downloadDetail.unknownPlace}
                </span>{' '}
                <span className="mono sub">{p.address}</span>
              </td>
              <td data-label={t.downloadDetail.cols.client}>{p.client ?? t.downloadDetail.unknownClient}</td>
              <td className="sub" data-label={t.downloadDetail.cols.link}>
                {t.downloadDetail.direction[p.direction]} · {p.transport.toUpperCase()}
              </td>
              <td className="num mono" data-label={t.downloadDetail.cols.down}>
                {rate(p.downBps)}
              </td>
              <td className="num mono" data-label={t.downloadDetail.cols.up}>
                {rate(p.upBps)}
              </td>
              <td className="num mono" data-label={t.downloadDetail.cols.has}>
                {Math.round(p.has * 100)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
