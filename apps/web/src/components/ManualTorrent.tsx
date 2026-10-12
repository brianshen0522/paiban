import type { TmdbSuggestion, Torrent, TorrentInspection, TorrentInvalidReason } from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { t } from '../copy';
import { ApiFailure, get, isSpaceError, post, upload } from '../lib/api';
import { bytes, filmTitle, sourceLabel, versionLabel } from '../lib/format';
import { keys } from '../lib/queries';
import { Modal } from './Modal';

/**
 * Adding a torrent by hand (Brian, 2026-10-09; D26 changed; docs/11-pages.md, "Add a torrent by hand"):
 * a magnet link or a .torrent file → what will be downloaded (the largest video only) → which
 * film it is, picked on TMDB → start. Each step slides in; nothing is downloaded before "start".
 */
type Step = 'source' | 'wait' | 'confirm' | 'done';
type Mode = 'magnet' | 'file';
/** How often a magnet's inspection is asked about while the swarm is being asked. */
const POLL_MS = 1500;

export type PresetFilm = Pick<TmdbSuggestion, 'tmdbId' | 'title' | 'originalTitle' | 'year' | 'posterUrl'>;

function errorText(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.code === 'TORRENT_INVALID' && e.details && 'reason' in e.details)
      return t.manual.invalid[e.details.reason as TorrentInvalidReason] ?? t.errors.TORRENT_INVALID ?? '';
    if (e.code === 'RATE_LIMITED') return t.manual.rateLimited;
    if (e.code === 'UPLOAD_TOO_LARGE') return t.manual.tooLarge;
    if (e.code === 'TMDB_UNREACHABLE') return t.manual.tmdbDown;
    if (e.code === 'TMDB_NOT_CONFIGURED') return t.manual.filmUnavailable;
    if (isSpaceError(e))
      return t.manual.spaceShort(bytes(e.details.needBytes), bytes(e.details.freeBytes), bytes(e.details.shortBytes));
    const known = (t.errors as Partial<Record<string, string>>)[e.code];
    if (known) return known;
  }
  return t.common.unknownError;
}

export function ManualTorrentDialog({ onClose, preset }: { onClose: () => void; preset?: PresetFilm | null }) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>('source');
  const [mode, setMode] = useState<Mode>('magnet');
  const [magnet, setMagnet] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<TorrentInspection | null>(null);
  const [film, setFilm] = useState<PresetFilm | null>(preset ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; n: number } | null>(null);
  const [result, setResult] = useState<{ torrent: Torrent; joined: boolean } | null>(null);
  const fail = (e: unknown) => setError((x) => ({ text: errorText(e), n: (x?.n ?? 0) + 1 }));

  // A magnet waits for the swarm: ask the server until the inspection is settled.
  const pending = step === 'wait' && inspection ? inspection.id : null;
  const poll = useQuery({
    queryKey: ['inspection', pending],
    queryFn: () => get<TorrentInspection>(`/api/torrents/inspect/${pending}`),
    enabled: !!pending,
    refetchInterval: POLL_MS,
  });
  useEffect(() => {
    const x = poll.data;
    if (!x || step !== 'wait') return;
    if (x.state === 'ready') {
      setInspection(x);
      setStep('confirm');
    } else if (x.state === 'failed') {
      setError((e) => ({ text: t.manual.invalid[x.errorCode ?? 'NO_METADATA'], n: (e?.n ?? 0) + 1 }));
      setInspection(null);
      setStep('source');
    }
  }, [poll.data, step]);

  const read = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const x =
        mode === 'magnet'
          ? await post<TorrentInspection>('/api/torrents/inspect', { magnet: magnet.trim() })
          : file
            ? await upload<TorrentInspection>('/api/torrents/inspect', file)
            : null;
      if (!x) return;
      if (x.state === 'failed') {
        fail(new ApiFailure('TORRENT_INVALID', 422, '', { reason: x.errorCode ?? 'BAD_TORRENT' }));
        return;
      }
      setInspection(x);
      setStep(x.state === 'pending' ? 'wait' : 'confirm');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const finish = (r: { torrent: Torrent; joined: boolean }) => {
    setResult(r);
    setStep('done');
    void qc.invalidateQueries({ queryKey: ['torrents'] });
    void qc.invalidateQueries({ queryKey: keys.library });
    void qc.invalidateQueries({ queryKey: keys.storage });
  };

  const start = async () => {
    if (!inspection || !film) return;
    setBusy(true);
    setError(null);
    try {
      finish(
        await post<{ torrent: Torrent; joined: boolean }>('/api/torrents/manual', {
          inspectionId: inspection.id,
          tmdbId: film.tmdbId,
        }),
      );
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const existing = inspection?.existing;
    if (!existing) return;
    setBusy(true);
    setError(null);
    try {
      finish({ torrent: await post<Torrent>(`/api/torrents/${existing.id}/hold`, {}), joined: true });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const restart = () => {
    setInspection(null);
    setError(null);
    setStep('source');
  };

  const canRead = mode === 'magnet' ? magnet.trim().length > 0 : !!file;
  return (
    <Modal title={t.manual.title} onClose={onClose} busy={busy} wide>
      <div className="mt-steps" aria-live="polite">
        {step === 'source' && (
          <form className="mt-step" key="source" onSubmit={read}>
            <p className="sub">{t.manual.lead}</p>
            <ModeSwitch
              mode={mode}
              onMode={(m) => {
                setMode(m);
                setError(null);
              }}
            />
            {mode === 'magnet' ? (
              <label className="field">
                <span>{t.manual.magnetLabel}</span>
                <textarea
                  className="mt-magnet"
                  rows={3}
                  value={magnet}
                  spellCheck={false}
                  placeholder={t.manual.magnetPlaceholder}
                  onChange={(e) => setMagnet(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && canRead) {
                      e.preventDefault();
                      void read();
                    }
                  }}
                />
              </label>
            ) : (
              <DropZone file={file} onFile={setFile} />
            )}
            {error && <ErrorLine key={error.n} text={error.text} />}
            <div className="mt-actions">
              <button type="button" onClick={onClose} disabled={busy}>
                {t.manual.cancel}
              </button>
              <button type="submit" className="primary" disabled={!canRead || busy}>
                {busy ? t.manual.reading : t.manual.read}
              </button>
            </div>
          </form>
        )}

        {step === 'wait' && <Waiting key="wait" onBack={restart} />}

        {step === 'confirm' && inspection && (
          <div className="mt-step" key="confirm">
            <FileCard x={inspection} />
            {inspection.existing ? (
              <Existing x={inspection.existing} busy={busy} onJoin={join} />
            ) : (
              <FilmPicker initial={inspection.guess.title} film={film} onFilm={setFilm} />
            )}
            {error && <ErrorLine key={error.n} text={error.text} />}
            <div className="mt-actions">
              <button type="button" onClick={restart} disabled={busy}>
                {t.manual.back}
              </button>
              {!inspection.existing && (
                <button type="button" className="primary" disabled={!film || busy} onClick={start}>
                  {busy ? t.manual.starting : t.manual.start}
                </button>
              )}
            </div>
          </div>
        )}

        {step === 'done' && result && (
          <div className="mt-step mt-done" key="done">
            <svg className="mt-check" viewBox="0 0 52 52" aria-hidden="true">
              <circle cx="26" cy="26" r="24" />
              <path d="M15 27 l7 7 l15 -16" />
            </svg>
            <h3>{result.joined ? t.manual.doneJoined : t.manual.done}</h3>
            <p className="sub">
              {filmTitle(result.torrent.movie).main} · {versionLabel(result.torrent.version) || '—'}
            </p>
            <p className="sub">{t.manual.doneHint}</p>
            <div className="mt-actions">
              <button type="button" onClick={onClose}>
                {t.manual.close}
              </button>
              <Link className="btn primary" to="/downloads" onClick={onClose}>
                {t.manual.goDownloads}
              </Link>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const modes: Mode[] = ['magnet', 'file'];
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = mode === 'magnet' ? 'file' : 'magnet';
    onMode(next);
    const tabs = e.currentTarget;
    requestAnimationFrame(() => tabs.querySelector<HTMLElement>(`[data-mode="${next}"]`)?.focus());
  };
  return (
    <div className="mt-seg" role="tablist" aria-label={t.manual.tabsLabel} onKeyDown={onKey}>
      <span className={`mt-seg-thumb ${mode}`} aria-hidden="true" />
      {modes.map((m) => (
        <button
          key={m}
          data-mode={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          tabIndex={mode === m ? 0 : -1}
          onClick={() => onMode(m)}
        >
          {t.manual.tabs[m]}
        </button>
      ))}
    </div>
  );
}

function DropZone({ file, onFile }: { file: File | null; onFile: (f: File | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const take = (f: File | undefined) => {
    if (f) onFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    take(e.dataTransfer.files[0]);
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the keyboard way in
    <div
      className={`mt-drop${over ? ' over' : ''}${file ? ' has' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <svg className="mt-drop-icon" viewBox="0 0 48 48" aria-hidden="true">
        <path d="M24 32V10m0 0l-8 8m8-8l8 8" />
        <path d="M10 30v6a4 4 0 0 0 4 4h20a4 4 0 0 0 4-4v-6" />
      </svg>
      <p>{over ? t.manual.dropActive : file ? t.manual.fileChosen(file.name) : t.manual.drop}</p>
      {!over && (
        <p className="sub">
          {t.manual.dropOr}{' '}
          <button type="button" className="link" onClick={() => input.current?.click()}>
            {t.manual.pick}
          </button>
        </p>
      )}
      <input
        ref={input}
        type="file"
        accept=".torrent,application/x-bittorrent"
        hidden
        onChange={(e) => take(e.target.files?.[0])}
      />
    </div>
  );
}

function Waiting({ onBack }: { onBack: () => void }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="mt-step mt-wait" role="status">
      <div className="mt-swarm" aria-hidden="true">
        <span className="core" />
        <span className="orbit o1">
          <i />
        </span>
        <span className="orbit o2">
          <i />
        </span>
        <span className="orbit o3">
          <i />
        </span>
      </div>
      <p>{t.manual.fetching}</p>
      <p className="sub">{t.manual.fetchingHint}</p>
      <p className="sub mono">{t.manual.elapsed(seconds)}</p>
      <div className="mt-actions">
        <button type="button" onClick={onBack}>
          {t.manual.back}
        </button>
      </div>
    </div>
  );
}

function FileCard({ x }: { x: TorrentInspection }) {
  const v = x.version;
  const chips = [v.quality, sourceLabel(v.source), v.videoCodec, v.bitDepth === 10 ? '10-bit' : ''].filter(Boolean);
  return (
    <section className="mt-file" aria-label={t.manual.willDownload}>
      <svg className="mt-file-icon" viewBox="0 0 40 40" aria-hidden="true">
        <rect x="6" y="9" width="28" height="22" rx="3" />
        <path d="M17 15.5v9l7-4.5z" />
      </svg>
      <div className="mt-file-text">
        <small>{t.manual.willDownload}</small>
        <b className="mono">{x.file?.path.split('/').at(-1) ?? x.name}</b>
        <span className="sub">
          {x.file ? bytes(x.file.sizeBytes) : ''} · {t.manual.skipped(x.skippedFiles)}
        </span>
        {x.subtitleFiles > 0 && <span className="mt-subs">{t.manual.withSubs(x.subtitleFiles)}</span>}
        {chips.length > 0 && (
          <span className="mt-chips">
            {chips.map((c) => (
              <span key={c} className="chip">
                {c}
              </span>
            ))}
          </span>
        )}
      </div>
    </section>
  );
}

function Existing({ x, busy, onJoin }: { x: Torrent; busy: boolean; onJoin: () => void }) {
  const name = filmTitle(x.movie);
  return (
    <section className="mt-existing">
      <p>
        <b>{t.manual.existing(`${name.main} · ${x.movie.year}`)}</b>
      </p>
      <p className="sub">{x.mine ? t.manual.existingMine : t.manual.existingJoin}</p>
      {x.mine ? (
        <Link className="btn" to="/downloads">
          {t.manual.goDownloads}
        </Link>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={onJoin}>
          {t.manual.joinExisting}
        </button>
      )}
    </section>
  );
}

/** TMDB films for what is typed, as a list of cards right in the dialog; one is picked. */
function FilmPicker({
  initial,
  film,
  onFilm,
}: {
  initial: string;
  film: PresetFilm | null;
  onFilm: (f: PresetFilm | null) => void;
}) {
  const [q, setQ] = useState(film ? film.title : initial);
  const [typed, setTyped] = useState(q.trim());
  const listId = useId();
  useEffect(() => {
    const id = setTimeout(() => setTyped(q.trim()), 300);
    return () => clearTimeout(id);
  }, [q]);
  const res = useQuery({
    queryKey: ['tmdb-suggest', typed],
    queryFn: () =>
      get<{ items: TmdbSuggestion[]; available: boolean }>(`/api/tmdb/suggest?q=${encodeURIComponent(typed)}`),
    enabled: !film && typed.length > 0,
    staleTime: 5 * 60_000,
  });

  if (film)
    return (
      <section className="mt-film-chosen" aria-label={t.manual.filmLabel}>
        <FilmThumb url={film.posterUrl} />
        <div>
          <small>{t.manual.filmLabel}</small>
          <b>{film.title}</b>
          <span className="sub">
            {[film.originalTitle !== film.title ? film.originalTitle : null, film.year].filter(Boolean).join(' · ')}
          </span>
        </div>
        <button type="button" className="link" onClick={() => onFilm(null)}>
          {t.manual.filmChange}
        </button>
      </section>
    );

  const items = res.data?.available ? res.data.items : [];
  return (
    <section className="mt-film">
      <div className="field">
        <label htmlFor={`${listId}-q`}>{t.manual.filmLabel}</label>
        <input
          id={`${listId}-q`}
          type="search"
          value={q}
          placeholder={t.manual.filmPlaceholder}
          aria-describedby={`${listId}-help`}
          onChange={(e) => setQ(e.target.value)}
        />
        <small id={`${listId}-help`}>{t.manual.filmHelp}</small>
      </div>
      {res.data && !res.data.available ? (
        <p className="mt-note bad">{t.manual.filmUnavailable}</p>
      ) : res.isFetching && !items.length ? (
        <p className="mt-note">{t.manual.filmSearching}</p>
      ) : typed && res.data && !items.length ? (
        <p className="mt-note">{t.manual.filmNone}</p>
      ) : (
        <ul className="mt-films" aria-label={t.manual.filmListLabel}>
          {items.map((s, i) => (
            <li key={s.tmdbId} style={{ animationDelay: `${i * 40}ms` }}>
              <button type="button" onClick={() => onFilm(s)}>
                <FilmThumb url={s.posterUrl} />
                <span>
                  <b>{s.title}</b>
                  <small>
                    {[s.originalTitle !== s.title ? s.originalTitle : null, s.year].filter(Boolean).join(' · ')}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FilmThumb({ url }: { url: string | null }) {
  return url ? (
    <img className="mt-thumb" src={url} alt="" width={40} height={60} loading="lazy" />
  ) : (
    <span className="mt-thumb empty" aria-hidden="true" />
  );
}

function ErrorLine({ text }: { text: string }) {
  return (
    <p className="mt-error" role="alert">
      {text}
    </p>
  );
}
