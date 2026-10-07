import type { Subtitle, Translation, TranslationMode } from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { Banner, Field, Progress } from '../../components/Bits';
import { Modal } from '../../components/Modal';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy/zh-TW';
import { asFailure, get, post } from '../../lib/api';
import { keys, useMe } from '../../lib/queries';
import { langName } from './SubtitlesTab';

const c = () => t.translate;

/** The languages offered first (docs/18-llm.md, "從哪裡開始"); any other BCP 47 code can be typed. */
export const TARGETS = ['zh-Hant', 'zh-Hans', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'th', 'vi', 'id'];
export const LANG_CODE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const OTHER = 'other';

/** The film's translations in progress, failed or cancelled (done ones are ordinary subtitles). */
export function useTranslations(torrentId: string) {
  return useQuery({
    queryKey: keys.translations(torrentId),
    queryFn: () => get<Translation[]>(`/api/torrents/${torrentId}/translations`),
    // Events say when one moves on; this is the fallback while one is running.
    refetchInterval: (q) => (q.state.data?.some((x) => x.state === 'running') ? 3000 : false),
  });
}

/** "Translate" on a subtitle row: target language and form, then start. */
export function TranslateDialog({ s, onClose }: { s: Subtitle; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const isAdmin = useMe().data?.user.role === 'admin';
  const [target, setTarget] = useState(s.language === 'zh-Hant' ? 'en' : 'zh-Hant');
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<TranslationMode>('plain');
  const [codeError, setCodeError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; toLlm: boolean } | null>(null);

  const start = async (e: FormEvent) => {
    e.preventDefault();
    const lang = target === OTHER ? code.trim() : target;
    if (!LANG_CODE.test(lang)) {
      setCodeError(true);
      return;
    }
    setCodeError(false);
    setBusy(true);
    setError(null);
    try {
      const r = await post<Translation>(`/api/subtitles/${s.id}/translate`, { targetLanguage: lang, mode });
      // The same translation that failed before carries on rather than starting over.
      toast(r.doneChunks > 0 ? c().resumed(r.doneChunks, r.totalChunks) : c().started);
      void qc.invalidateQueries({ queryKey: keys.translations(s.torrentId) });
      onClose();
    } catch (err) {
      const f = asFailure(err);
      const minutes =
        f.details && 'retryAfterSeconds' in f.details ? Math.max(1, Math.ceil(f.details.retryAfterSeconds / 60)) : 1;
      setError(
        f.code === 'LLM_NOT_CONFIGURED'
          ? { text: c().notConfigured, toLlm: isAdmin }
          : f.code === 'TRANSLATION_RUNNING'
            ? { text: c().running, toLlm: false }
            : f.code === 'RATE_LIMITED'
              ? { text: c().tooOften(minutes), toLlm: false }
              : f.code === 'VALIDATION'
                ? { text: c().invalid, toLlm: false }
                : { text: f.code === 'NETWORK' ? t.common.offline : t.common.unknownError, toLlm: false },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={c().dialog} onClose={onClose} busy={busy}>
      <form className="stack-form" onSubmit={start} noValidate>
        <p className="sub">{c().lead(langName(s.language), s.cueCount)}</p>
        <Field label={c().target}>
          {(id, note) => (
            <select id={id} aria-describedby={note} value={target} onChange={(e) => setTarget(e.target.value)}>
              {TARGETS.map((l) => (
                <option key={l} value={l}>
                  {langName(l)}
                </option>
              ))}
              <option value={OTHER}>{c().other}</option>
            </select>
          )}
        </Field>
        {target === OTHER && (
          <Field label={c().code} help={c().codeHelp} error={codeError ? c().codeInvalid : null}>
            {(id, note) => (
              <input
                id={id}
                aria-describedby={note}
                aria-invalid={codeError}
                className="mono"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="ja"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            )}
          </Field>
        )}
        <fieldset>
          <legend>{c().mode}</legend>
          {(['plain', 'bilingual'] as const).map((m) => (
            <label key={m} className="chk">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} />
              {m === 'plain' ? c().plain : c().bilingual}
            </label>
          ))}
        </fieldset>
        {error && (
          <Banner tone="bad">
            <span>{error.text}</span>
            {error.toLlm && (
              <Link className="btn" to="/admin/llm">
                {c().toLlm}
              </Link>
            )}
          </Banner>
        )}
        <div className="modal-act">
          <button type="button" disabled={busy} onClick={onClose}>
            {c().cancel}
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? c().starting : c().start}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Translations running, failed or cancelled, under the film's subtitles. */
export function TranslationList({ torrentId, subtitles }: { torrentId: string; subtitles: Subtitle[] }) {
  const list = useTranslations(torrentId);
  const shown = (list.data ?? []).filter((x) => x.state !== 'done');
  if (!shown.length) return null;
  const from = (x: Translation) => langName(subtitles.find((s) => s.id === x.sourceId)?.language ?? '');
  return (
    <div className="translations" aria-live="polite">
      <h3>{c().listTitle}</h3>
      {shown.map((x) => (
        <TranslationRow key={x.id} x={x} from={from(x)} />
      ))}
    </div>
  );
}

function TranslationRow({ x, from }: { x: Translation; from: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const to = `${langName(x.targetLanguage)}（${c().modeTag[x.mode]}）`;
  const act = async (what: 'cancel' | 'resume') => {
    setBusy(true);
    setError(false);
    try {
      await post<Translation>(`/api/translations/${x.id}/${what}`);
      void qc.invalidateQueries({ queryKey: keys.translations(x.torrentId) });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const text =
    x.state === 'running'
      ? x.totalChunks
        ? c().progress(from, to, x.doneChunks, x.totalChunks)
        : c().preparing(from, to)
      : x.state === 'failed'
        ? c().failed(from, to, c().errors[x.errorCode ?? ''] ?? t.common.unknownError)
        : c().cancelled(from, to, x.doneChunks, x.totalChunks);
  return (
    <div className="tr-row">
      <div className="tr-main">
        <span className={x.state === 'failed' ? 'bad' : undefined}>{text}</span>
        {x.state === 'running' && (
          <Progress live value={x.totalChunks ? x.doneChunks / x.totalChunks : 0} label={text} />
        )}
        {error && <span className="bad">{c().actionFailed}</span>}
      </div>
      <div className="tr-act">
        {x.state === 'running' ? (
          <button type="button" disabled={busy} onClick={() => void act('cancel')}>
            {c().cancelBtn}
          </button>
        ) : (
          <button type="button" className="strong" disabled={busy} onClick={() => void act('resume')}>
            {c().resume}
          </button>
        )}
      </div>
    </div>
  );
}
