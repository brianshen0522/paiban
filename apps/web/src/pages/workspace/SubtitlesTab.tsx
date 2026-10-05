import type { Candidate, CandidateList, Lang, ProviderStatus, Subtitle, Workspace } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Banner, Chip, ConfirmInline, Skeleton, type Tone } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy/zh-TW';
import { type ApiFailure, asFailure, candidateReason, del, post, upload } from '../../lib/api';
import { bytes } from '../../lib/format';
import { keys, useCandidates, useMe } from '../../lib/queries';

const LANGS: Lang[] = ['zh-Hant', 'zh-Hans', 'en'];
const SEARCHED: ProviderStatus['id'][] = ['justsubtitles', 'yify', 'assrt'];
const ACCEPT = ['srt', 'ass', 'ssa', 'vtt', 'zip', 'rar', '7z'];

export const langName = (l: string): string => t.langs[l] ?? l;
export const providerName = (p: string): string => t.subs.providers[p] ?? p;
const scorePct = (s: number | null) => (s == null ? null : Math.round(s * 100));

/** docs/11-pages.md, "字幕": the film's subtitles, the search over every source, the assisted source and uploads. */
export function SubtitlesTab({ ws }: { ws: Workspace }) {
  return (
    <>
      <AddedSubtitles ws={ws} />
      <FindSubtitles ws={ws} />
    </>
  );
}

function AddedSubtitles({ ws }: { ws: Workspace }) {
  const subs = ws.subtitles;
  return (
    <section className="card">
      <h2>{t.subs.added}</h2>
      {subs.length === 0 ? (
        <p className="sub">{t.subs.noneYet}</p>
      ) : (
        <>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{t.subs.cols.lang}</th>
                  <th>{t.subs.cols.provider}</th>
                  <th>{t.subs.cols.release}</th>
                  <th>{t.subs.cols.status}</th>
                  <th className="act">{t.subs.cols.action}</th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <AddedRow key={s.id} s={s} torrentId={ws.item.torrent.id} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub">{t.subs.sharedNote}</p>
        </>
      )}
    </section>
  );
}

function AddedRow({ s, torrentId }: { s: Subtitle; torrentId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(false);
    try {
      await del(`/api/subtitles/${s.id}`);
      toast(t.subs.removed);
      void qc.invalidateQueries({ queryKey: keys.workspace(torrentId) });
      void qc.invalidateQueries({ queryKey: keys.candidates(torrentId) });
      void qc.invalidateQueries({ queryKey: keys.library });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  return (
    <>
      <tr>
        <td>{langName(s.language)}</td>
        <td>{providerName(s.provider)}</td>
        <td className="rel">
          <span className="mono">{s.releaseName}</span>
        </td>
        <td>
          {s.status === 'confirmed' ? (
            <Chip tone="ok">{t.subs.confirmed(scorePct(s.score))}</Chip>
          ) : (
            <Chip tone="warn">{t.subs.draft(scorePct(s.score))}</Chip>
          )}{' '}
          {s.addedBy && <span className="sub">{s.addedBy.displayName}</span>}
        </td>
        <td className="act">
          <Link className="btn strong" to={`/library/${torrentId}/sync/${s.id}`}>
            {s.status === 'confirmed' ? t.subs.resync : t.subs.sync}
          </Link>
          <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
            {t.subs.remove}
          </button>
        </td>
      </tr>
      {(confirm || error) && (
        <tr className="blocked">
          <td colSpan={5}>
            {confirm && (
              <ConfirmInline
                text={t.subs.confirmRemove}
                confirmLabel={t.subs.remove}
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

/** Seconds until an ISO time, ticking once a second while there is one to show. */
function useCountdown(until: string | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  if (!until) return null;
  const s = Math.ceil((Date.parse(until) - now) / 1000);
  return s > 0 ? s : null;
}

function FindSubtitles({ ws }: { ws: Workspace }) {
  const torrentId = ws.item.torrent.id;
  const me = useMe().data;
  const qc = useQueryClient();
  const list = useCandidates(torrentId);
  const [langs, setLangs] = useState<Lang[]>(() => me?.user.prefs.langs ?? ['zh-Hant']);
  const [langError, setLangError] = useState(false);
  const [busy, setBusy] = useState<'search' | 'rank' | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);

  const data = list.data;
  const media = ws.item.torrent.media;
  const providers = (data?.providers ?? []).filter((p) => SEARCHED.includes(p.id));
  const zimuku = data?.providers.find((p) => p.id === 'zimuku');
  const allDisabled = providers.length > 0 && providers.every((p) => p.state === 'disabled');
  const running = providers.some((p) => p.state === 'running');
  const searched = providers.some((p) => p.state === 'ok' || p.state === 'error');

  const toggle = (l: Lang) => {
    if (langs.includes(l)) {
      if (langs.length === 1) {
        setLangError(true);
        return;
      }
      setLangs(langs.filter((x) => x !== l));
    } else setLangs(LANGS.filter((x) => x === l || langs.includes(x)));
    setLangError(false);
  };

  const call = async (what: 'search' | 'rank', body: object, path: string) => {
    setBusy(what);
    setError(null);
    try {
      const next = await post<CandidateList>(path, body);
      qc.setQueryData(keys.candidates(torrentId), next);
    } catch (e) {
      setError(asFailure(e));
    } finally {
      setBusy(null);
    }
  };
  const search = (provider?: ProviderStatus['id']) =>
    call(
      'search',
      { languages: langs, ...(provider ? { provider } : {}), ...(searched || provider ? { refresh: true } : {}) },
      `/api/torrents/${torrentId}/subtitle-search`,
    );
  const rank = () => call('rank', { languages: langs }, `/api/torrents/${torrentId}/candidates/rank`);

  // A candidate is shown when its language is one of those picked; unknown and uploads always are.
  const shown = (c: Candidate) =>
    c.provider === 'upload' ||
    c.language === 'und' ||
    (c.language === 'zh' ? langs.includes('zh-Hant') || langs.includes('zh-Hans') : langs.includes(c.language));
  let cands = (data?.candidates ?? []).filter(shown);
  const ranked = data?.ranking === 'done';
  if (ranked) cands = cands.slice().sort((a, b) => (b.align.score ?? -1) - (a.align.score ?? -1));
  const rankable = (data?.candidates ?? []).some((c) => c.provider !== 'upload' || c.fetch === 'ready');
  const speechReady = media?.analysis === 'ready';
  const rankBlocked = !speechReady
    ? media?.analysis === 'pending' || media?.analysis === 'running'
      ? t.subs.rankWaiting
      : t.subs.rankNoSpeech
    : null;
  const credit = providers.find((p) => p.credit)?.credit ?? null;
  const showCredit = !!credit && cands.some((c) => c.provider === 'assrt');

  return (
    <>
      <section className="card">
        <h2>{t.subs.find}</h2>
        {list.isError ? (
          <Banner tone="bad">
            <span>{t.subs.loadError}</span>
            <button type="button" onClick={() => list.refetch()}>
              {t.common.retry}
            </button>
          </Banner>
        ) : !data ? (
          <Skeleton lines={2} />
        ) : (
          <>
            <div className="frow">
              <fieldset className="fchips">
                <legend className="sub">{t.subs.langLabel}</legend>
                {LANGS.map((l) => (
                  <button key={l} type="button" aria-pressed={langs.includes(l)} onClick={() => toggle(l)}>
                    {langName(l)}
                  </button>
                ))}
              </fieldset>
              <button
                type="button"
                className="primary"
                disabled={allDisabled || running || busy === 'search'}
                aria-busy={running || busy === 'search'}
                onClick={() => search()}
              >
                {running || busy === 'search' ? t.subs.searching : searched ? t.subs.research : t.subs.search}
              </button>
              {allDisabled && <span className="sub">{t.subs.allDisabled}</span>}
              {(data.candidates.length > 0 || data.ranking !== 'idle') && (
                <button
                  type="button"
                  disabled={!!rankBlocked || data.ranking === 'running' || busy === 'rank' || !rankable}
                  aria-describedby={rankBlocked ? 'rank-why' : undefined}
                  onClick={rank}
                >
                  {data.ranking === 'running' || busy === 'rank'
                    ? t.subs.ranking
                    : data.ranking === 'done'
                      ? t.subs.rerank
                      : t.subs.rank}
                </button>
              )}
            </div>
            {langError && (
              <small className="err" role="alert">
                {t.subs.keepOneLang}
              </small>
            )}
            {rankBlocked && data.candidates.length > 0 && (
              <p className="sub" id="rank-why">
                {rankBlocked}
              </p>
            )}
            {error && (
              <Banner tone="bad">
                <span>{error.code === 'NETWORK' ? t.common.offline : t.common.unknownError}</span>
                <button type="button" onClick={() => setError(null)}>
                  {t.common.gotIt}
                </button>
              </Banner>
            )}
            <ul className="provs">
              {providers.map((p) => (
                <ProviderChip key={p.id} p={p} onRetry={() => search(p.id)} />
              ))}
              {zimuku && zimuku.state !== 'disabled' && (
                <li>
                  <Chip>{`${providerName('zimuku')}：${t.subs.provState.manual}`}</Chip>
                </li>
              )}
            </ul>
            {cands.length > 0 ? (
              <>
                <div className="tw">
                  <table>
                    <thead>
                      <tr>
                        <th>{t.subs.cols.provider}</th>
                        <th>{t.subs.cols.lang}</th>
                        <th>{t.subs.cols.release}</th>
                        <th className="num">{t.subs.cols.score}</th>
                        <th className="act">{t.subs.cols.action}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cands.map((c) => (
                        <CandidateRow
                          key={c.id}
                          c={c}
                          torrentId={torrentId}
                          ranking={data.ranking === 'running'}
                          prefsConvert={me?.user.prefs.convertToTraditional ?? true}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="sub">{t.subs.candHint}</p>
                {showCredit && credit && (
                  <p className="sub">
                    {t.subs.creditBefore}
                    <a href={credit.url} target="_blank" rel="noopener noreferrer">
                      {credit.name}
                    </a>
                    {t.subs.creditAfter}
                  </p>
                )}
              </>
            ) : searched && !running ? (
              <p className="sub">{t.subs.noResults}</p>
            ) : !searched ? (
              <p className="sub">{t.subs.idleHint}</p>
            ) : null}
          </>
        )}
      </section>
      <section className="two">
        {zimuku && zimuku.state !== 'disabled' && (
          <div className="card">
            <h2>{t.subs.zimuku.title}</h2>
            <p className="sub">{t.subs.zimuku.lead}</p>
            <ol className="howto">
              {t.subs.zimuku.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {data?.zimukuUrl ? (
              <a className="btn" href={data.zimukuUrl} target="_blank" rel="noopener noreferrer">
                {t.subs.zimuku.open}
              </a>
            ) : (
              <p className="sub">{t.subs.zimuku.noUrl}</p>
            )}
          </div>
        )}
        <UploadCard torrentId={torrentId} />
      </section>
    </>
  );
}

function ProviderChip({ p, onRetry }: { p: ProviderStatus; onRetry: () => void }) {
  const wait = useCountdown(p.error?.retryAt ?? null);
  const name = providerName(p.id);
  let tone: Tone = '';
  let text: string;
  switch (p.state) {
    case 'disabled':
      text = t.subs.provState.disabled;
      break;
    case 'manual':
      text = t.subs.provState.manual;
      break;
    case 'running':
      tone = 'info';
      text = t.subs.provState.running;
      break;
    case 'ok':
      tone = 'ok';
      text = t.subs.provState.count(p.count);
      break;
    case 'error': {
      tone = 'bad';
      const code = p.error?.code;
      text =
        code === 'NOT_CONFIGURED'
          ? (t.subs.notConfigured[p.id] ?? t.subs.provError.NOT_CONFIGURED)
          : code
            ? t.subs.provError[code] + (code === 'RATE_LIMITED' && wait ? t.subs.retryIn(wait) : '')
            : t.common.unknownError;
      break;
    }
    default:
      text = t.subs.provState.idle;
  }
  return (
    <li>
      <Chip tone={tone}>{`${name}：${text}`}</Chip>{' '}
      {p.state === 'error' && p.error?.code !== 'NOT_CONFIGURED' && (
        <button type="button" onClick={onRetry}>
          {t.subs.retry}
        </button>
      )}
    </li>
  );
}

function flags(c: Candidate): { text: string; hit?: boolean }[] {
  const f = t.subs.flags;
  const out: { text: string; hit?: boolean }[] = [];
  if (c.flags.matchesRelease) out.push({ text: f.matchesRelease, hit: true });
  if (c.flags.hearingImpaired) out.push({ text: f.hearingImpaired });
  if (c.flags.convertedFrom) out.push({ text: f.converted(c.flags.convertedFrom) });
  if (c.language === 'zh-Hans') out.push({ text: f.canConvert });
  if (c.flags.ass) out.push({ text: f.ass });
  if (c.flags.bilingual) out.push({ text: f.bilingual });
  if (c.language === 'zh' && c.fetch !== 'ready') out.push({ text: f.judgeLater });
  if (c.flags.archive) out.push({ text: f.archive });
  return out;
}

function CandidateRow({
  c,
  torrentId,
  ranking,
  prefsConvert,
}: {
  c: Candidate;
  torrentId: string;
  ranking: boolean;
  prefsConvert: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await post<Subtitle>(`/api/candidates/${c.id}/add`, { convertToTraditional: prefsConvert });
      const first = s.convertedToTraditional
        ? t.subs.addedConverted
        : (c.language === 'zh' || c.language === 'und' || c.provider === 'upload') && s.language !== c.language
          ? t.subs.addedDetected(langName(s.language))
          : t.subs.addedPlain;
      toast(`${first}${t.subs.nextStep}`, {
        label: t.subs.toSync,
        run: () => navigate(`/library/${torrentId}/sync/${s.id}`),
      });
      void qc.invalidateQueries({ queryKey: keys.workspace(torrentId) });
      void qc.invalidateQueries({ queryKey: keys.candidates(torrentId) });
      void qc.invalidateQueries({ queryKey: keys.library });
    } catch (e) {
      const f = asFailure(e);
      const reason = candidateReason(f);
      setError(
        reason === 'TIMEOUT'
          ? t.subs.stillFetching
          : reason
            ? (t.subs.fetchErrors[reason] ?? t.common.unknownError)
            : f.code === 'SUBTITLE_DUPLICATE'
              ? t.subs.duplicate
              : f.code === 'NETWORK'
                ? t.common.offline
                : t.common.unknownError,
      );
      if (reason) void qc.invalidateQueries({ queryKey: keys.candidates(torrentId) });
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await del(`/api/candidates/${c.id}`);
      void qc.invalidateQueries({ queryKey: keys.candidates(torrentId) });
    } catch {
      setError(t.common.unknownError);
    } finally {
      setBusy(false);
    }
  };

  const pctScore = scorePct(c.align.score);
  const scoreCell =
    c.align.state === 'done' && pctScore != null ? (
      <>
        <b className={`mono ${pctScore >= 70 ? 'good' : pctScore >= 55 ? 'warn' : 'bad'}`}>{pctScore}%</b>
        {c.recommended && (
          <>
            {' '}
            <Chip tone="ok">{t.subs.recommended}</Chip>
          </>
        )}
      </>
    ) : ranking && (c.align.state === 'queued' || c.align.state === 'running') ? (
      <span className="sub">{t.subs.computing}</span>
    ) : (
      <span className="sub">—</span>
    );

  return (
    <>
      <tr>
        <td>{providerName(c.provider)}</td>
        <td>
          {langName(c.language)}
          {c.languageLabel && <span className="sub mono"> {c.languageLabel}</span>}
        </td>
        <td className="rel">
          <span className="mono">{c.releaseName}</span>
          <br />
          <span className="sub">
            {c.uploader ? t.subs.uploadedBy(c.uploader) : ''}
            {flags(c).map((g) => (
              <i key={g.text} className={`tagx${g.hit ? ' hit' : ''}`}>
                {g.text}
              </i>
            ))}
          </span>
          {c.fetch === 'failed' && (
            <div className="err">{c.fetchError ? t.subs.fetchErrors[c.fetchError] : t.common.unknownError}</div>
          )}
        </td>
        <td className="num">{scoreCell}</td>
        <td className="act">
          {c.added ? (
            <Chip tone="ok">{t.subs.addedChip}</Chip>
          ) : c.fetch === 'fetching' && !busy ? (
            <span className="sub">{t.subs.processing}</span>
          ) : c.fetch === 'failed' ? (
            <button type="button" disabled={busy} onClick={remove}>
              {t.subs.remove}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={add}>
              {busy ? t.subs.adding : t.subs.add}
            </button>
          )}
        </td>
      </tr>
      {error && (
        <tr className="blocked">
          <td colSpan={5}>
            <Banner tone="bad">
              <span>{error}</span>
              <button type="button" onClick={() => setError(null)}>
                {t.common.gotIt}
              </button>
            </Banner>
          </td>
        </tr>
      )}
    </>
  );
}

function UploadCard({ torrentId }: { torrentId: string }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const max = me?.limits.uploadMaxBytes ?? 20 * 1024 ** 2;

  const send = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!ACCEPT.includes(ext)) {
      setError(t.subs.upload.unsupported);
      return;
    }
    if (file.size > max) {
      setError(t.subs.upload.tooLarge(bytes(max)));
      return;
    }
    setBusy(true);
    try {
      const next = await upload<CandidateList>(`/api/torrents/${torrentId}/uploads`, file);
      qc.setQueryData(keys.candidates(torrentId), next);
    } catch (e) {
      const f = asFailure(e);
      setError(
        f.code === 'UNSUPPORTED_FILE'
          ? t.subs.upload.unsupported
          : f.code === 'UPLOAD_TOO_LARGE'
            ? t.subs.upload.tooLarge(bytes(max))
            : t.subs.upload.failed,
      );
    } finally {
      setBusy(false);
    }
  };
  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setOver(false);
    void send(e.dataTransfer.files[0]);
  };

  return (
    <div className="card">
      <h2>{t.subs.upload.title}</h2>
      <label
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        aria-busy={busy}
      >
        <b>{busy ? t.subs.upload.uploading : t.subs.upload.drop}</b>
        <span className="sub">{t.subs.upload.hint}</span>
        <input
          type="file"
          className="sr-only"
          accept={ACCEPT.map((x) => `.${x}`).join(',')}
          disabled={busy}
          aria-describedby={error ? 'upload-err' : undefined}
          onChange={(e) => {
            void send(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </label>
      {error && (
        <small id="upload-err" className="err" role="alert">
          {error}
        </small>
      )}
    </div>
  );
}
