import type { Me, MovieDetail, Torrent, Version } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { Link, useNavigate, useOutletContext, useParams } from 'react-router';
import { Banner, Chip, Skeleton } from '../components/Bits';
import { Poster } from '../components/Poster';
import { Rating } from '../components/Rating';
import { SpaceShort } from '../components/SpaceShort';
import { useToast } from '../components/Toasts';
import { UsageBar } from '../components/Usage';
import { locale, t } from '../copy';
import { ApiFailure, post } from '../lib/api';
import { audioLabel, bytes, dateTime, filmTitle, genreLabel, percent, shortHash, sourceLabel } from '../lib/format';
import { keys, useMovie } from '../lib/queries';
import { SearchError } from './SearchPage';
import { NotFoundPage } from './StatusPages';

/** docs/11-pages.md, "Film page (03, 04)". */
export function MoviePage() {
  const me = useOutletContext<Me>();
  const id = Number(useParams().ytsId);
  const movie = useMovie(id);

  if (movie.isError) {
    if (movie.error instanceof ApiFailure && movie.error.code === 'NOT_FOUND') return <NotFoundPage />;
    return (
      <>
        <BackLink />
        <SearchError error={movie.error} isAdmin={me.user.role === 'admin'} retry={() => movie.refetch()} />
      </>
    );
  }
  if (!movie.data) {
    return (
      <>
        <BackLink />
        <Skeleton lines={6} />
      </>
    );
  }
  const m = movie.data;
  return (
    <>
      <BackLink />
      {m.stale && <Banner tone="warn">{t.movie.stale(dateTime(m.fetchedAt))}</Banner>}
      <div className="mhead">
        <Poster url={m.posterUrl} title={m.title} year={m.year} runtimeMin={m.runtimeMin} size="lg" />
        <div className="minfo">
          <h1>{filmTitle(m).main}</h1>
          <p className="sub">
            {[
              filmTitle(m).other,
              String(m.year),
              m.runtimeMin > 0 ? t.movie.runtime(m.runtimeMin) : null,
              m.genres.map(genreLabel).join(t.common.listSep) || null,
            ]
              .filter(Boolean)
              .join(' · ')}{' '}
            · <Rating m={m} />
          </p>
          {(locale === 'en' && m.summaryEn) || m.summary ? (
            <p className="plot">{(locale === 'en' && m.summaryEn) || m.summary}</p>
          ) : null}
          {m.tmdbUrl && (
            <p>
              <a href={m.tmdbUrl} target="_blank" rel="noopener noreferrer">
                {t.movie.onTmdb} ↗
              </a>
            </p>
          )}
          <p className="sub">
            {t.movie.capacity(bytes(m.usage.usedBytes), bytes(m.usage.limitBytes), bytes(m.usage.freeBytes))}
          </p>
          <UsageBar usage={m.usage} />
        </div>
      </div>
      <Versions movie={m} preferred={me.user.prefs.quality} />
    </>
  );
}

function BackLink() {
  const navigate = useNavigate();
  return (
    <div className="crumbs">
      <button
        type="button"
        className="link"
        onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/search'))}
      >
        {t.movie.backToSearch}
      </button>
    </div>
  );
}

function Versions({ movie, preferred }: { movie: MovieDetail; preferred: string }) {
  if (movie.versions.length === 0) return <Banner tone="info">{t.movie.noVersions}</Banner>;
  return (
    <section className="card">
      <h2>{t.movie.versions}</h2>
      <div className="tw">
        <table className="rtable">
          <thead>
            <tr>
              <th>{t.movie.cols.quality}</th>
              <th>{t.movie.cols.codec}</th>
              <th>{t.movie.cols.audio}</th>
              <th className="num">{t.movie.cols.size}</th>
              <th className="num">{t.movie.cols.seeds}</th>
              <th>{t.movie.cols.preview}</th>
              <th className="act">{t.movie.cols.status}</th>
            </tr>
          </thead>
          <tbody>
            {movie.versions.map((v) => (
              <VersionRow key={v.infoHash} movie={movie} v={v} preferred={v.quality === preferred} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="sub">{t.movie.note}</p>
    </section>
  );
}

function holderLine(v: Extract<Version['local'], { kind: 'present' }>): string {
  const names = v.holders.map((h) => h.displayName);
  const who = names.length > 1 ? t.movie.andOthers(names[0] ?? '', names.length) : (names[0] ?? '');
  switch (v.status) {
    case 'downloading':
      return t.movie.othersDownloading(who, percent(v.progress));
    case 'queued':
      return t.movie.othersQueued(who);
    case 'paused':
      return t.movie.othersPaused(who);
    case 'failed':
      return t.movie.othersFailed(who);
    default:
      return t.movie.othersHave(who);
  }
}

function VersionRow({ movie, v, preferred }: { movie: MovieDetail; v: Version; preferred: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.movie(movie.ytsId) });
    void qc.invalidateQueries({ queryKey: keys.torrents('mine') });
    void qc.invalidateQueries({ queryKey: keys.storage });
  };

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ torrent: Torrent; joined: boolean }>('/api/torrents', {
        ytsId: movie.ytsId,
        infoHash: v.infoHash,
      });
      const label = `${movie.title} ${v.quality}`;
      if (res.joined) toast(t.movie.joined);
      else
        toast(
          res.torrent.queuePosition && res.torrent.queuePosition > 1
            ? t.movie.queuedToast(label)
            : t.movie.started(label),
          { label: t.movie.viewDownloads, run: () => navigate('/downloads') },
        );
      refresh();
    } catch (err) {
      setError(err instanceof ApiFailure ? err : new ApiFailure('INTERNAL', 500, 'unexpected'));
    } finally {
      setBusy(false);
    }
  };

  const retry = async (torrentId: string) => {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/torrents/${torrentId}/retry`);
      toast(t.downloads.retried);
      refresh();
    } catch (err) {
      setError(err instanceof ApiFailure ? err : new ApiFailure('INTERNAL', 500, 'unexpected'));
    } finally {
      setBusy(false);
    }
  };

  const local = v.local;
  let action: React.ReactNode;
  if (local.kind === 'none') {
    action =
      v.seeds === 0 ? (
        <>
          <span className="sub">{t.movie.noSeeds}</span>
          <button type="button" className="strong" disabled={busy} onClick={download}>
            {t.movie.downloadAnyway}
          </button>
        </>
      ) : (
        <button type="button" className="strong" disabled={busy} onClick={download}>
          {t.movie.download}
        </button>
      );
  } else if (local.mine) {
    const open = (
      <Link className="btn" to={`/library/${local.torrentId}/subtitles`}>
        {t.common.open}
      </Link>
    );
    const view = (
      <Link className="btn" to="/downloads">
        {t.common.view}
      </Link>
    );
    action =
      local.status === 'ready' ? (
        <>
          <Chip tone="ok">{t.movie.inLibrary}</Chip>
          {open}
        </>
      ) : local.status === 'analyzing' ? (
        <>
          <Chip tone="info">{t.movie.analyzing}</Chip>
          {open}
        </>
      ) : local.status === 'failed' ? (
        <>
          <Chip tone="bad">{t.movie.failed}</Chip>
          <button type="button" className="strong" disabled={busy} onClick={() => retry(local.torrentId)}>
            {t.movie.retry}
          </button>
        </>
      ) : (
        <>
          <Chip tone="info">
            {local.status === 'downloading'
              ? t.movie.downloadingPct(percent(local.progress))
              : local.status === 'queued'
                ? t.movie.queued
                : t.movie.paused}
          </Chip>
          {view}
        </>
      );
  } else {
    action = (
      <>
        <span className="sub">{holderLine(local)}</span>
        <button type="button" className="strong" disabled={busy} onClick={download}>
          {t.movie.join}
        </button>
      </>
    );
  }

  return (
    <Fragment>
      <tr className={preferred ? 'pref' : undefined}>
        <td className="lead">
          <b>{v.quality}</b> <span className="sub-i">{sourceLabel(v.source)}</span>
          {preferred && (
            <span className="tagx hit" title={t.movie.preferred}>
              ★
            </span>
          )}
          <div className="hash mono">{shortHash(v.infoHash)}</div>
        </td>
        <td className="mono" data-label={t.movie.cols.codec}>
          {v.videoCodec} · {v.bitDepth}-bit
        </td>
        <td data-label={t.movie.cols.audio}>{audioLabel(v.audio)}</td>
        <td className="num" data-label={t.movie.cols.size}>
          {bytes(v.sizeBytes)}
        </td>
        <td className="num" data-label={t.movie.cols.seeds}>
          {v.seeds} / {v.peers}
        </td>
        <td data-label={t.movie.cols.preview}>
          {v.directPlay ? (
            <Chip tone="ok">{t.movie.directPreview}</Chip>
          ) : (
            <Chip tone="warn">{t.movie.needsPreview}</Chip>
          )}
        </td>
        <td className="act">{action}</td>
      </tr>
      {error && (
        <tr className="blocked">
          <td colSpan={7}>
            {error.code === 'STORAGE_LIMIT' || error.code === 'DISK_FULL' ? (
              <SpaceShort error={error} onClose={() => setError(null)} />
            ) : (
              <Banner tone="bad">
                <span>
                  {error.code === 'TORRENT_STATE'
                    ? t.movie.beingDeleted
                    : (t.errors[error.code as keyof typeof t.errors] ?? t.common.unknownError)}
                </span>
                <button type="button" onClick={() => setError(null)}>
                  {t.common.gotIt}
                </button>
              </Banner>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  );
}
