import type { AlignModelCheck, Lang, SecretName, Settings, SourceCheck, SourceHealth, SourceId } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Banner, Chip, Field, PageHead, Skeleton, Switch } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy/zh-TW';
import { ApiFailure, del, patch, post, put } from '../../lib/api';
import { relative } from '../../lib/format';
import { type AdminSettings, keys, useAdminSettings } from '../../lib/queries';
import { fieldMessage } from './fieldMessages';

const c = () => t.admin.sources;

/** docs/11-pages.md, "來源設定": three tabs (Brian, 2026-10-06: one long page was too long). */
export function SourcesPage() {
  const s = useAdminSettings();
  return (
    <>
      <PageHead title={c().title} lead={c().lead} />
      {s.isError ? (
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => s.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      ) : !s.data ? (
        <Skeleton />
      ) : (
        <Cards data={s.data} />
      )}
    </>
  );
}

const TABS = ['movies', 'subtitles', 'align'] as const;
type Tab = (typeof TABS)[number];
const isTab = (v: string | null): v is Tab => TABS.includes(v as Tab);

/** One line under a tab: the worst state among its sources, so a problem shows without opening it. */
function healthNote(states: (SourceHealth | undefined)[]): string {
  const down = states.filter((h) => h?.state === 'down').length;
  const warn = states.filter((h) => h?.state === 'warn').length;
  if (down) return c().tabNotes.down(down);
  if (warn) return c().tabNotes.warn(warn);
  if (states.some((h) => !h?.checkedAt && h?.state !== 'off')) return c().tabNotes.untested;
  return c().tabNotes.ok;
}

function Cards({ data }: { data: AdminSettings }) {
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab');
  const tab: Tab = isTab(asked) ? asked : 'movies';
  const go = (k: Tab) => setParams({ tab: k }, { replace: true });
  const health = (id: SourceHealth['id']) => data.sources.find((x) => x.id === id);
  const p = data.settings.providers;
  const secrets = data.info.secrets;
  const llm = data.settings.align.llm.provider;
  const notes: Record<Tab, string> = {
    movies: healthNote([health('yts'), health('tmdb')]),
    subtitles: healthNote(
      (['justsubtitles', 'yify', 'assrt'] as const).filter((id) => p[id].enabled).map((id) => health(id)),
    ),
    align: c().tabNotes.align(data.settings.align.asr, c().tabNotes.llm[llm] ?? llm),
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const i = TABS.indexOf(tab);
    const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length] ?? tab;
    e.preventDefault();
    go(next);
    requestAnimationFrame(() => document.getElementById(`src-tab-${next}`)?.focus());
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={c().tabsLabel} onKeyDown={onKey}>
        {TABS.map((k) => (
          <button
            key={k}
            id={`src-tab-${k}`}
            type="button"
            role="tab"
            aria-selected={tab === k}
            aria-controls="src-panel"
            tabIndex={tab === k ? 0 : -1}
            onClick={() => go(k)}
          >
            {c().tabs[k]}
            <small>{notes[k]}</small>
          </button>
        ))}
      </div>
      <div id="src-panel" role="tabpanel" aria-labelledby={`src-tab-${tab}`} className="src-grid">
        {tab === 'movies' && (
          <>
            <YtsCard baseUrl={data.settings.yts.baseUrl} health={health('yts')} />
            <SourceCard title={c().tmdb} health={health('tmdb')}>
              <p className="sub">{c().tmdbLead}</p>
              <SecretField
                name="tmdbKey"
                label={c().tmdbKey}
                keyName={c().tmdbKeyName}
                help={c().tmdbHelp}
                isSet={secrets.tmdbKey}
              />
              <div className="frow">
                <TestButton id="tmdb" />
              </div>
            </SourceCard>
          </>
        )}
        {tab === 'subtitles' && (
          <>
            <JustSubtitlesCard data={data} health={health('justsubtitles')} />
            <SourceCard title={c().yify} health={health('yify')}>
              <EnableSwitch path={['yify']} checked={p.yify.enabled} />
              <UrlForm
                settingKey="providers.yify.baseUrl"
                body={(v) => ({ providers: { yify: { baseUrl: v } } })}
                value={p.yify.baseUrl}
                label={c().yifyUrl}
                help={c().yifyHelp}
                placeholder="https://"
              >
                <TestButton id="yify" />
              </UrlForm>
            </SourceCard>
            <SourceCard title={c().assrt} health={health('assrt')}>
              <EnableSwitch path={['assrt']} checked={p.assrt.enabled} />
              <SecretField
                name="assrtToken"
                label={c().assrtToken}
                keyName={c().assrtKeyName}
                help={c().assrtHelp}
                isSet={secrets.assrtToken}
                saveLabel={c().saveToken}
              />
              <p className="sub">{c().assrtNote}</p>
              <div className="frow">
                <TestButton id="assrt" />
              </div>
            </SourceCard>
            <SourceCard title={c().zimuku} chip={<Chip tone="">{c().status.manual}</Chip>}>
              <EnableSwitch path={['zimuku']} checked={p.zimuku.enabled} label={c().zimukuEnable} />
              <UrlForm
                settingKey="providers.zimuku.searchUrl"
                body={(v) => ({ providers: { zimuku: { searchUrl: v } } })}
                value={p.zimuku.searchUrl}
                label={c().zimukuUrl}
                help={c().zimukuHelp}
                placeholder="https://…{q}…"
              />
            </SourceCard>
            <CommonCard settings={data.settings} />
          </>
        )}
        {tab === 'align' && <AlignCard settings={data.settings} llmKeySet={secrets.llmKey} />}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ building blocks */

/** Saves a partial update; answers with a sentence per invalid key (docs/13, "介面上的錯誤訊息"). */
function useSave() {
  const qc = useQueryClient();
  const toast = useToast();
  return async (body: Record<string, unknown>, quiet = false): Promise<Record<string, string>> => {
    try {
      await patch('/api/admin/settings', body);
      if (!quiet) toast(c().saved);
      void qc.invalidateQueries({ queryKey: keys.adminSettings });
      return {};
    } catch (err) {
      const fields =
        err instanceof ApiFailure && err.details && 'fields' in err.details
          ? (err.details.fields as Record<string, string>)
          : null;
      if (!fields)
        return { _: err instanceof ApiFailure && err.code === 'NETWORK' ? t.common.offline : t.common.unknownError };
      return Object.fromEntries(Object.entries(fields).map(([k, code]) => [k, fieldMessage(k, code)]));
    }
  };
}

function HealthChip({ health }: { health: SourceHealth | undefined }) {
  const state = health?.state ?? 'none';
  const tone = state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'down' ? 'bad' : '';
  return (
    <>
      <Chip tone={tone}>{c().status[state]}</Chip>
      {health?.checkedAt && <span className="sub">{c().checked(relative(health.checkedAt))}</span>}
    </>
  );
}

function SourceCard({
  title,
  health,
  chip,
  children,
}: {
  title: string;
  health?: SourceHealth;
  chip?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card stack">
      <h2>
        {title} {chip ?? <HealthChip health={health} />}
      </h2>
      {children}
    </section>
  );
}

/** The sentence beside a source's test button (docs/13-settings.md, "測試連線"). */
export function checkText(id: SourceId, r: SourceCheck): string {
  switch (r.code) {
    case 'OK':
      if (id === 'yts') return t.tests.ok((r.ms / 1000).toFixed(1));
      if (id === 'tmdb') return t.tests.okTmdb;
      if (id === 'yify') return t.tests.okYify;
      if (id === 'assrt') return t.tests.okAssrt;
      return t.tests.okCount(Number(r.data.count ?? 0));
    case 'NOT_CONFIGURED':
      return id === 'yts' || id === 'yify' ? t.tests.NOT_CONFIGURED : t.tests.NOT_CONFIGURED_KEY;
    case 'REDIRECTED':
      return t.tests.REDIRECTED(String(r.data.host ?? ''));
    case 'INVALID_KEY':
    case 'UNREACHABLE':
    case 'BAD_RESPONSE':
    case 'RATE_LIMITED':
      return t.tests[r.code];
  }
}

function TestButton({ id, label, disabled }: { id: SourceId; label?: string; disabled?: boolean }) {
  const qc = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SourceCheck | null>(null);
  const [failed, setFailed] = useState(false);
  const test = async () => {
    setTesting(true);
    setResult(null);
    setFailed(false);
    try {
      setResult(await post<SourceCheck>(`/api/admin/sources/${id}/test`));
      void qc.invalidateQueries({ queryKey: keys.adminSettings });
    } catch {
      setFailed(true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <button type="button" onClick={test} disabled={testing || disabled}>
        {label ?? c().test}
      </button>
      <span className={result ? (result.ok ? 'good' : 'bad') : failed ? 'bad' : 'sub'} aria-live="polite">
        {testing ? c().testing : result ? checkText(id, result) : failed ? t.common.unknownError : ''}
      </span>
    </>
  );
}

/** A write-only key: a password box, saved with PUT, cleared with DELETE (docs/13-settings.md, "金鑰"). */
function SecretField({
  name,
  label,
  keyName,
  help,
  isSet,
  saveLabel,
}: {
  name: SecretName;
  label: string;
  keyName: string;
  help: string;
  isSet: boolean;
  saveLabel?: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = () => void qc.invalidateQueries({ queryKey: keys.adminSettings });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!value.trim()) {
      toast(c().keyEmpty);
      return;
    }
    setBusy(true);
    try {
      await put(`/api/admin/secrets/${name}`, { value: value.trim() });
      setValue('');
      toast(c().keySaved(keyName));
      done();
    } catch (err) {
      setError(err instanceof ApiFailure && err.code === 'NETWORK' ? t.common.offline : t.common.unknownError);
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    setBusy(true);
    try {
      await del(`/api/admin/secrets/${name}`);
      toast(c().keyCleared(keyName));
      done();
    } catch {
      setError(t.common.unknownError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="stack" onSubmit={save} noValidate>
      <Field label={label} help={help} error={error}>
        {(id, note) => (
          <input
            id={id}
            aria-describedby={note}
            className="mono"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={isSet ? c().secretSet : c().secretUnset}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
      </Field>
      <div className="frow">
        <button type="submit" disabled={busy}>
          {saveLabel ?? c().saveKey}
        </button>
        {isSet && (
          <button type="button" onClick={clear} disabled={busy}>
            {c().clearKey}
          </button>
        )}
      </div>
    </form>
  );
}

/** A source's on/off switch; saved as soon as it changes. */
function EnableSwitch({
  path,
  checked,
  label,
}: {
  path: ['justsubtitles' | 'yify' | 'assrt' | 'zimuku'];
  checked: boolean;
  label?: string;
}) {
  const save = useSave();
  const toast = useToast();
  const [on, setOn] = useState(checked);
  useEffect(() => setOn(checked), [checked]);
  return (
    <Switch
      checked={on}
      label={label ?? c().enable}
      onChange={async (v) => {
        setOn(v);
        const errors = await save({ providers: { [path[0]]: { enabled: v } } });
        if (Object.keys(errors).length) {
          setOn(!v);
          toast(Object.values(errors)[0]);
        }
      }}
    />
  );
}

function UrlForm({
  settingKey,
  body,
  value,
  label,
  help,
  placeholder,
  children,
}: {
  settingKey: string;
  body: (v: string) => Record<string, unknown>;
  value: string;
  label: string;
  help: string;
  placeholder: string;
  children?: ReactNode;
}) {
  const save = useSave();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(value), [value]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    const errors = await save(body(draft.trim()));
    setError(errors[settingKey] ?? errors._ ?? null);
    setSaving(false);
  };
  return (
    <form className="stack" onSubmit={submit} noValidate>
      <Field label={label} help={help} error={error}>
        {(id, note) => (
          <input
            id={id}
            aria-describedby={note}
            aria-invalid={!!error}
            className="mono"
            type="url"
            inputMode="url"
            spellCheck={false}
            autoCapitalize="none"
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        )}
      </Field>
      <div className="frow">
        <button type="submit" disabled={saving || draft.trim() === value}>
          {c().saveUrl}
        </button>
        {children}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ cards */

function YtsCard({ baseUrl, health }: { baseUrl: string; health: SourceHealth | undefined }) {
  const qc = useQueryClient();
  return (
    <SourceCard title={c().yts} health={health}>
      <UrlForm
        settingKey="yts.baseUrl"
        body={(v) => {
          void qc.invalidateQueries({ queryKey: ['search'] });
          return { yts: { baseUrl: v } };
        }}
        value={baseUrl}
        label={c().ytsUrl}
        help={c().ytsHelp}
        placeholder="https://"
      >
        <TestButton id="yts" disabled={!baseUrl} />
      </UrlForm>
    </SourceCard>
  );
}

function JustSubtitlesCard({ data, health }: { data: AdminSettings; health: SourceHealth | undefined }) {
  const save = useSave();
  const toast = useToast();
  const js = data.settings.providers.justsubtitles;
  const [mode, setMode] = useState(js.mode);
  useEffect(() => setMode(js.mode), [js.mode]);
  return (
    <SourceCard title={c().justsubtitles} health={health}>
      <EnableSwitch path={['justsubtitles']} checked={js.enabled} />
      <Field
        label={c().jsMode}
        help={mode === 'subdl' && !data.info.secrets.subdlKey ? c().jsModeNoKey : c().jsModeHelp}
      >
        {(id, note) => (
          <select
            id={id}
            aria-describedby={note}
            value={mode}
            onChange={async (e) => {
              const next = e.target.value as typeof mode;
              setMode(next);
              const errors = await save({ providers: { justsubtitles: { mode: next } } });
              if (Object.keys(errors).length) {
                setMode(js.mode);
                toast(Object.values(errors)[0]);
              }
            }}
          >
            <option value="direct">{c().jsModeDirect}</option>
            <option value="subdl">{c().jsModeSubdl}</option>
          </select>
        )}
      </Field>
      <SecretField
        name="subdlKey"
        label={c().subdlKey}
        keyName={c().subdlKeyName}
        help={c().subdlHelp}
        isSet={data.info.secrets.subdlKey}
      />
      <p className="sub">{c().jsNote}</p>
      <div className="frow">
        <TestButton id="justsubtitles" />
      </div>
      <div className="frow">
        <TestButton id="subdl" label={c().testSubdl} />
      </div>
    </SourceCard>
  );
}

const LANGS: Lang[] = ['zh-Hant', 'zh-Hans', 'en'];

function CommonCard({ settings }: { settings: Settings }) {
  const save = useSave();
  const [hours, setHours] = useState(String(settings.providers.cacheHours));
  const [langs, setLangs] = useState<Lang[]>(settings.subtitles.defaultLangs);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => setHours(String(settings.providers.cacheHours)), [settings.providers.cacheHours]);
  useEffect(() => setLangs(settings.subtitles.defaultLangs), [settings.subtitles.defaultLangs]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(hours);
    if (!/^\d+$/.test(hours.trim()) || n < 1 || n > 168) {
      setErrors({ 'providers.cacheHours': t.fields.range1to168 });
      return;
    }
    if (!langs.length) {
      setErrors({ 'subtitles.defaultLangs': t.fields.atLeastOneLang });
      return;
    }
    setSaving(true);
    setErrors(await save({ providers: { cacheHours: n }, subtitles: { defaultLangs: langs } }));
    setSaving(false);
  };
  return (
    <section className="card stack">
      <h2>{c().common}</h2>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label={c().cacheHours} help={c().cacheHelp} error={errors['providers.cacheHours']}>
          {(id, note) => (
            <input
              id={id}
              aria-describedby={note}
              aria-invalid={!!errors['providers.cacheHours']}
              className="mono"
              inputMode="numeric"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
          )}
        </Field>
        <fieldset className="field">
          <legend>{c().defaultLangs}</legend>
          <div className="frow">
            {LANGS.map((l) => (
              <label key={l} className="chk">
                <input
                  type="checkbox"
                  checked={langs.includes(l)}
                  onChange={(e) =>
                    setLangs((cur) =>
                      e.target.checked ? LANGS.filter((x) => x === l || cur.includes(x)) : cur.filter((x) => x !== l),
                    )
                  }
                />{' '}
                {t.langs[l]}
              </label>
            ))}
          </div>
          {errors['subtitles.defaultLangs'] ? (
            <small className="err" role="alert">
              {errors['subtitles.defaultLangs']}
            </small>
          ) : (
            <small>{c().defaultLangsHelp}</small>
          )}
        </fieldset>
        {errors._ && (
          <p className="bad" role="alert">
            {errors._}
          </p>
        )}
        <div className="frow">
          <button type="submit" className="primary" disabled={saving}>
            {t.common.save}
          </button>
        </div>
      </form>
    </section>
  );
}

function AlignCard({ settings, llmKeySet }: { settings: Settings; llmKeySet: boolean }) {
  const save = useSave();
  const toast = useToast();
  const llm = settings.align.llm;
  const [asr, setAsr] = useState(settings.align.asr);
  const [provider, setProvider] = useState(llm.provider);
  const [model, setModel] = useState(llm.model);
  const [baseUrl, setBaseUrl] = useState(llm.baseUrl);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AlignModelCheck | null>(null);
  useEffect(() => setAsr(settings.align.asr), [settings.align.asr]);
  useEffect(() => {
    setProvider(llm.provider);
    setModel(llm.model);
    setBaseUrl(llm.baseUrl);
  }, [llm.provider, llm.model, llm.baseUrl]);
  const dirty = provider !== llm.provider || model !== llm.model || baseUrl !== llm.baseUrl;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setResult(null);
    setErrors(await save({ align: { llm: { provider, model: model.trim(), baseUrl: baseUrl.trim() } } }));
    setSaving(false);
  };
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await post<AlignModelCheck>('/api/admin/align/test'));
    } catch {
      setResult({ ok: false, code: 'UNREACHABLE', ms: 0 });
    } finally {
      setTesting(false);
    }
  };
  const resultText = (r: AlignModelCheck) =>
    r.code === 'OK' ? t.modelTests.OK((r.ms / 1000).toFixed(1)) : t.modelTests[r.code];

  return (
    <section className="card stack">
      <h2>{c().align}</h2>
      <p className="sub">{c().alignLead}</p>
      <Switch
        checked={asr}
        label={c().asr}
        onChange={async (v) => {
          setAsr(v);
          const errs = await save({ align: { asr: v } });
          if (Object.keys(errs).length) {
            setAsr(!v);
            toast(Object.values(errs)[0]);
          }
        }}
      />
      <p className="sub">{c().asrHelp}</p>
      <form className="stack" onSubmit={submit} noValidate>
        <Field label={c().provider} help={c().providerHelp}>
          {(id, note) => (
            <select
              id={id}
              aria-describedby={note}
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
            >
              <option value="none">{c().providerNone}</option>
              <option value="anthropic">{c().providerAnthropic}</option>
              <option value="openai">{c().providerOpenai}</option>
            </select>
          )}
        </Field>
        {provider !== 'none' && (
          <Field
            label={c().model}
            help={provider === 'anthropic' ? c().modelHelpAnthropic : c().modelHelpOpenai}
            error={errors['align.llm.model']}
          >
            {(id, note) => (
              <input
                id={id}
                aria-describedby={note}
                aria-invalid={!!errors['align.llm.model']}
                className="mono"
                spellCheck={false}
                autoCapitalize="none"
                placeholder={provider === 'anthropic' ? 'claude-opus-5-5' : 'qwen-plus'}
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            )}
          </Field>
        )}
        {provider === 'openai' && (
          <Field label={c().baseUrl} help={c().baseUrlHelp} error={errors['align.llm.baseUrl']}>
            {(id, note) => (
              <input
                id={id}
                aria-describedby={note}
                aria-invalid={!!errors['align.llm.baseUrl']}
                className="mono"
                type="url"
                inputMode="url"
                spellCheck={false}
                autoCapitalize="none"
                placeholder="https://"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            )}
          </Field>
        )}
        {errors._ && (
          <p className="bad" role="alert">
            {errors._}
          </p>
        )}
        <div className="frow">
          <button type="submit" className="primary" disabled={saving || !dirty}>
            {c().saveAlign}
          </button>
        </div>
      </form>
      {llm.provider !== 'none' && (
        <>
          <SecretField
            name="llmKey"
            label={c().llmKey}
            keyName={c().llmKeyName}
            help={c().llmKeyHelp}
            isSet={llmKeySet}
          />
          <div className="frow">
            <button type="button" onClick={test} disabled={testing || dirty}>
              {c().testModel}
            </button>
            <span className={result ? (result.ok ? 'good' : 'bad') : 'sub'} aria-live="polite">
              {testing ? c().testing : result ? resultText(result) : ''}
            </span>
          </div>
        </>
      )}
    </section>
  );
}
