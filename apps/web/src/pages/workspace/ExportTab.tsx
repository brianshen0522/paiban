import type { Export, Workspace } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { Banner, Chip, ConfirmInline, Progress } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy/zh-TW';
import { type ApiFailure, asFailure, del, fieldCodes, isSpaceError, post } from '../../lib/api';
import { bytes, percent, relative } from '../../lib/format';
import { keys } from '../../lib/queries';
import { langName, providerName } from './SubtitlesTab';

/** The MKV language tag shown next to a track (docs/11-pages.md, "匯出"): zh counts as zh-TW. */
export function trackTag(lang: string): string {
  if (lang === 'zh-Hant' || lang === 'zh') return 'zh-TW';
  if (lang === 'zh-Hans') return 'zh-CN';
  return lang;
}

/** `Title.Year.Quality.zh-TW.mkv` with every run of non-alphanumerics turned into one dot. */
export function defaultFileName(title: string, year: number, quality: string): string {
  const name = title.replace(/[^A-Za-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '');
  return `${name || 'movie'}.${year}.${quality}.zh-TW.mkv`;
}

export type FileNameProblem = 'EXTENSION' | 'CHARACTERS' | 'TOO_LONG' | null;

/** The same checks as the server (docs/11-pages.md, "檔名"). */
export function checkFileName(name: string): FileNameProblem {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused
  if (/[/\\:*?"<>|\u0000-\u001f\u007f]/.test(name) || name.startsWith('.') || name !== name.trim()) return 'CHARACTERS';
  if (!/.\.mkv$/i.test(name)) return 'EXTENSION';
  if ([...name].length > 200) return 'TOO_LONG';
  return null;
}

/** docs/11-pages.md, "匯出": choose tracks, name the file, check the space, start; the film's exports below. */
export function ExportTab({ ws }: { ws: Workspace }) {
  const qc = useQueryClient();
  const toast = useToast();
  const x = ws.item.torrent;
  const confirmed = useMemo(() => ws.subtitles.filter((s) => s.status === 'confirmed'), [ws.subtitles]);
  const pending = ws.subtitles.filter((s) => s.status !== 'confirmed');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [def, setDef] = useState<string | null>(null);
  const [name, setName] = useState(() => defaultFileName(x.movie.title, x.movie.year, x.version.quality));
  const [nameError, setNameError] = useState<FileNameProblem>(null);
  const [trackError, setTrackError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const on = confirmed.filter((s) => !off.has(s.id));
  // "預設顯示" stays on a ticked track: when it is unticked it moves to the first ticked one.
  const defId = on.some((s) => s.id === def) ? def : (on[0]?.id ?? null);
  useEffect(() => {
    if (defId !== def) setDef(defId);
  }, [defId, def]);

  const need = ws.exportNeedBytes;
  const free = ws.usage.freeBytes;
  const fits = !ws.usage.over && need <= free;
  // One export of this film at a time: a second press while one is packing would only queue a copy.
  const packing = ws.exports.some((e) => e.state === 'queued' || e.state === 'running');

  const start = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (packing) return;
    if (!on.length) {
      setTrackError(true);
      return;
    }
    const problem = checkFileName(name);
    setNameError(problem);
    if (problem) {
      nameRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await post<Export>(`/api/torrents/${x.id}/exports`, {
        fileName: name,
        tracks: on.map((s) => ({ subtitleId: s.id, isDefault: s.id === defId })),
      });
      toast(t.exportTab.started);
      void qc.invalidateQueries({ queryKey: keys.workspace(x.id) });
      void qc.invalidateQueries({ queryKey: keys.exports });
      void qc.invalidateQueries({ queryKey: keys.library });
    } catch (err) {
      const f = asFailure(err);
      if (f.code === 'INVALID_FILENAME') {
        const code = fieldCodes(f).fileName;
        setNameError(code === 'TOO_LONG' ? 'TOO_LONG' : code === 'EXTENSION' ? 'EXTENSION' : 'CHARACTERS');
        nameRef.current?.focus();
      } else if (f.code === 'NO_CONFIRMED_SUBTITLE') {
        setTrackError(true);
        void qc.invalidateQueries({ queryKey: keys.workspace(x.id) });
      } else setError(f);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>{t.exportTab.tracks}</h2>
        <form className="ws-form" onSubmit={start} noValidate>
          {confirmed.length ? (
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>{t.exportTab.cols.sub}</th>
                    <th>{t.exportTab.cols.provider}</th>
                    <th>{t.exportTab.cols.tag}</th>
                    <th>{t.exportTab.cols.def}</th>
                  </tr>
                </thead>
                <tbody>
                  {confirmed.map((s) => {
                    const ticked = !off.has(s.id);
                    return (
                      <tr key={s.id}>
                        <td>
                          <label className="chk">
                            <input
                              type="checkbox"
                              checked={ticked}
                              onChange={(e) => {
                                const next = new Set(off);
                                if (e.target.checked) next.delete(s.id);
                                else next.add(s.id);
                                setOff(next);
                                setTrackError(false);
                              }}
                            />{' '}
                            {langName(s.language)}
                          </label>
                        </td>
                        <td>{providerName(s.provider)}</td>
                        <td>
                          <span className="mono">{trackTag(s.language)}</span>
                        </td>
                        <td>
                          <label className="chk">
                            <input
                              type="radio"
                              name="default-track"
                              checked={defId === s.id}
                              disabled={!ticked}
                              onChange={() => setDef(s.id)}
                            />{' '}
                            {t.exportTab.defaultShown}
                          </label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="sub">{t.exportTab.noConfirmed}</p>
          )}
          {trackError && (
            <small className="err" role="alert">
              {t.exportTab.pickOne}
            </small>
          )}
          {pending.length > 0 && (
            <p className="sub">
              {t.exportTab.pending(pending.length, pending.map((s) => langName(s.language)).join('、'))}{' '}
              <Link className="link" to={`/library/${x.id}/sync/${pending[0]?.id ?? ''}`}>
                {t.exportTab.goSync}
              </Link>
            </p>
          )}
          <div className="field">
            <label htmlFor="exp-name">{t.exportTab.fileName}</label>
            <input
              id="exp-name"
              ref={nameRef}
              className="mono"
              value={name}
              aria-invalid={!!nameError}
              aria-describedby="exp-name-note"
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
            />
            {nameError ? (
              <small id="exp-name-note" className="err" role="alert">
                {nameError === 'TOO_LONG' ? t.exportTab.fileLong : t.exportTab.fileChars}
              </small>
            ) : (
              <small id="exp-name-note">{t.exportTab.fileHelp}</small>
            )}
          </div>
          {fits ? (
            <div className="banner info">
              <span>{t.exportTab.spaceOk(bytes(need), bytes(free), bytes(Math.max(0, free - need)))}</span>
            </div>
          ) : (
            <div className="banner bad" role="alert">
              <span>
                <b>{t.exportTab.spaceShortTitle}</b>{' '}
                {t.exportTab.spaceShort(bytes(need), bytes(free), bytes(Math.max(0, need - free)))}
              </span>
              <Link className="btn" to="/storage">
                {t.common.goStorage}
              </Link>
            </div>
          )}
          {error && (
            <div className="banner bad" role="alert">
              <span>
                {isSpaceError(error)
                  ? error.code === 'DISK_FULL'
                    ? t.space.diskFull(bytes(error.details.shortBytes))
                    : `${t.exportTab.spaceShortTitle} ${t.exportTab.spaceShort(
                        bytes(error.details.needBytes),
                        bytes(error.details.freeBytes),
                        bytes(error.details.shortBytes),
                      )}`
                  : error.code === 'MEDIA_NOT_READY'
                    ? t.exportTab.notReady
                    : error.code === 'NETWORK'
                      ? t.common.offline
                      : t.common.unknownError}
              </span>
              <button type="button" onClick={() => setError(null)}>
                {t.common.gotIt}
              </button>
            </div>
          )}
          <div className="frow">
            <button type="submit" className="primary" disabled={busy || packing || !confirmed.length || !fits}>
              {busy ? t.exportTab.starting : packing ? t.exportTab.packing : t.exportTab.start}
            </button>
            <span className="sub">{packing ? t.exportTab.packingNote : t.exportTab.keepNote}</span>
          </div>
        </form>
      </section>
      <section className="card">
        <h2>{t.exportTab.list}</h2>
        {ws.exports.length ? (
          <>
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>{t.exportTab.cols2.file}</th>
                    <th className="num">{t.exportTab.cols2.size}</th>
                    <th>{t.exportTab.cols2.state}</th>
                    <th className="act">{t.exportTab.cols2.action}</th>
                  </tr>
                </thead>
                <tbody>
                  {ws.exports.map((e) => (
                    <ExportRow key={e.id} e={e} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub">{t.exportTab.listNote}</p>
          </>
        ) : (
          <p className="sub">{t.exportTab.none}</p>
        )}
      </section>
    </>
  );
}

export function exportState(e: Export) {
  if (e.state === 'queued') return <Chip>{t.exportTab.queued}</Chip>;
  if (e.state === 'running')
    return (
      <div className="exp-prog">
        <Progress value={e.progress} label={`${e.fileName} ${percent(e.progress)}%`} />
        <span className="sub">{t.exportTab.running(percent(e.progress))}</span>
      </div>
    );
  if (e.state === 'done') return <Chip tone="ok">{t.exportTab.done}</Chip>;
  return (
    <>
      <Chip tone="bad">{t.exportTab.failed}</Chip>
      <div className="sub">
        {t.exportTab.failedLine(e.errorCode ? (t.exportTab.errors[e.errorCode] ?? e.errorCode) : t.common.unknownError)}
      </div>
    </>
  );
}

/** One export with download and delete; shared by the export tab and the storage page. */
export function ExportRow({ e, showFilm = false }: { e: Export; showFilm?: boolean }) {
  // The storage page words it shorter (docs/10-storage.md, "確認的文字").
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const size = e.state === 'done' ? bytes(e.sizeBytes) : null;
  const remove = async () => {
    setBusy(true);
    setError(false);
    try {
      const r = await del<{ freedBytes: number }>(`/api/exports/${e.id}`);
      toast(r.freedBytes > 0 ? t.exportTab.deleted(bytes(r.freedBytes)) : t.exportTab.deletedNoSize);
      if (e.torrentId) void qc.invalidateQueries({ queryKey: keys.workspace(e.torrentId) });
      void qc.invalidateQueries({ queryKey: keys.exports });
      void qc.invalidateQueries({ queryKey: keys.storage });
      void qc.invalidateQueries({ queryKey: keys.library });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const tracks = e.tracks.map((x) => langName(x.language)).join('、');
  return (
    <>
      <tr>
        <td className="rel">
          <span className="mono">{e.fileName}</span>
          <br />
          <span className="sub">
            {[
              showFilm ? `${e.movieTitle} ${e.versionLabel}` : null,
              tracks,
              e.createdBy?.displayName ?? t.exportTab.removedUser,
              relative(e.createdAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </td>
        <td className="num">{bytes(e.sizeBytes)}</td>
        <td>{exportState(e)}</td>
        <td className="act">
          {e.state === 'done' && e.downloadUrl && (
            <a className="btn strong" href={e.downloadUrl} download={e.fileName}>
              {t.exportTab.download}
            </a>
          )}
          {e.canDelete && (
            <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
              {t.exportTab.delete}
            </button>
          )}
        </td>
      </tr>
      {(confirm || error) && (
        <tr className="blocked">
          <td colSpan={4}>
            {confirm && (
              <ConfirmInline
                text={
                  size
                    ? showFilm
                      ? t.storage.confirmExport(size)
                      : t.exportTab.confirmDelete(size)
                    : t.exportTab.confirmDeleteNoSize
                }
                confirmLabel={t.exportTab.delete}
                busy={busy}
                onConfirm={remove}
                onCancel={() => setConfirm(false)}
              />
            )}
            {error && <Banner tone="bad">{t.common.unknownError}</Banner>}
          </td>
        </tr>
      )}
    </>
  );
}
