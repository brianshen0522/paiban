import type { MediaStatus, Torrent } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Progress } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy';
import { type ApiFailure, asFailure, isSpaceError, post } from '../../lib/api';
import { bytes, percent } from '../../lib/format';
import { keys } from '../../lib/queries';

export const mediaError = (code: string | undefined): string =>
  code ? (t.media.errors[code] ?? t.media.otherError(code)) : t.common.unknownError;

/** docs/11-pages.md, "Sync (09)": which file the workbench plays, in one sentence. */
export function previewSentence(x: Torrent): string {
  const m = x.media;
  const codec = x.version.videoCodec || x.version.quality;
  if (!m || m.directPlay) return t.media.preview.direct;
  if (m.proxy.state === 'ready')
    return t.media.preview.proxy(codec, m.proxy.resolution ?? '480p', bytes(m.proxy.bytes));
  if (m.proxy.state === 'pending' || m.proxy.state === 'running')
    return t.media.preview.converting(codec, percent(m.proxy.progress));
  return t.media.preview.none(codec);
}

/** Whether there is a preview asset to ask for (docs/09, "Which file to play"). */
export const canRequestPreview = (m: MediaStatus): boolean =>
  !m.directPlay && (m.previewNeedBytes > 0 || m.proxy.state === 'none' || m.proxy.state === 'failed');

/**
 * Analysis, speech recognition and preview state for one film, with "Analyze again" and "Make preview file".
 * Progress arrives inside torrent events, so this re-renders by itself.
 */
export function MediaPanel({ torrent }: { torrent: Torrent }) {
  const m = torrent.media;
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<'analyze' | 'proxy' | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  if (!m) return null;

  const run = async (what: 'analyze' | 'proxy') => {
    setBusy(what);
    setError(null);
    try {
      const next = await post<MediaStatus>(`/api/media/${m.id}/${what}`);
      qc.setQueryData(keys.media(m.id), next);
      void qc.invalidateQueries({ queryKey: keys.workspace(torrent.id) });
      toast(what === 'analyze' ? t.media.analyzeRequested : t.media.proxyRequested);
    } catch (e) {
      setError(asFailure(e));
    } finally {
      setBusy(null);
    }
  };

  const analysis =
    m.analysis === 'pending' || m.analysis === 'running'
      ? { tone: 'info', text: t.media.analysisPending, action: null }
      : m.analysis === 'failed'
        ? { tone: 'warn', text: t.media.analysisFailed(mediaError(m.errors.analysis)), action: t.media.reanalyze }
        : m.analysis === 'none'
          ? { tone: 'warn', text: t.media.analysisNone, action: t.media.analyze }
          : null;

  const asr =
    m.asr && m.asr.state !== 'none'
      ? m.asr.state === 'ready'
        ? t.media.asr.ready(m.asr.language ? (t.media.asrLangs[m.asr.language] ?? m.asr.language) : null)
        : m.asr.state === 'failed'
          ? t.media.asr.failed(mediaError(m.errors.asr))
          : m.asr.state === 'running'
            ? t.media.asr.running
            : t.media.asr.pending
      : null;

  const converting = !m.directPlay && (m.proxy.state === 'pending' || m.proxy.state === 'running');
  const offer = canRequestPreview(m);

  return (
    <div className="mediapanel">
      {analysis && (
        <div className={`banner ${analysis.tone}`} role={analysis.tone === 'warn' ? 'status' : undefined}>
          <span>{analysis.text}</span>
          {analysis.action && (
            <button type="button" disabled={busy !== null} onClick={() => run('analyze')}>
              {analysis.action}
            </button>
          )}
        </div>
      )}
      {asr && <p className="sub">{asr}</p>}
      {converting && (
        <div className="mp-progress">
          <Progress value={m.proxy.progress} label={t.media.proxyProgress(percent(m.proxy.progress))} />
          <span className="sub mono">{t.media.proxyProgress(percent(m.proxy.progress))}</span>
        </div>
      )}
      {offer && (
        <div className="frow">
          {m.errors.proxy === 'PREVIEW_NO_SPACE' ? (
            <span className="sub">{t.media.proxyNoSpace}</span>
          ) : m.proxy.state === 'failed' ? (
            <span className="sub">{t.media.proxyFailed(mediaError(m.errors.proxy))}</span>
          ) : null}
          <button type="button" className="strong" disabled={busy !== null} onClick={() => run('proxy')}>
            {busy === 'proxy' ? t.media.requesting : t.media.requestProxy}
          </button>
          {m.previewNeedBytes > 0 && <span className="sub">{t.media.proxyNeed(bytes(m.previewNeedBytes))}</span>}
        </div>
      )}
      {error &&
        (isSpaceError(error) ? (
          <div className="banner bad" role="alert">
            <span>
              {error.code === 'DISK_FULL'
                ? t.space.diskFull(bytes(error.details.shortBytes))
                : t.media.proxyShort(
                    bytes(error.details.needBytes),
                    bytes(error.details.freeBytes),
                    bytes(error.details.shortBytes),
                  )}
            </span>
            <div className="frow">
              <Link className="btn" to="/storage">
                {t.common.goStorage}
              </Link>
              <button type="button" onClick={() => setError(null)}>
                {t.common.gotIt}
              </button>
            </div>
          </div>
        ) : (
          <div className="banner bad" role="alert">
            <span>{error.code === 'NETWORK' ? t.common.offline : t.common.unknownError}</span>
            <button type="button" onClick={() => setError(null)}>
              {t.common.gotIt}
            </button>
          </div>
        ))}
    </div>
  );
}
