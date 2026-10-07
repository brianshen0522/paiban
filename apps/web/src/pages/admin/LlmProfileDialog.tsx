import type { LlmCheck, LlmParams, LlmProfile, LlmProfileInput, LlmProvider } from '@paiban/shared';
import { type FormEvent, useId, useState } from 'react';
import { Field, Switch } from '../../components/Bits';
import { Modal } from '../../components/Modal';
import { t } from '../../copy/zh-TW';
import { asFailure, fieldCodes, post, put } from '../../lib/api';

const c = () => t.llm;

export const PROVIDERS: LlmProvider[] = [
  'openai',
  'anthropic',
  'azure-openai',
  'azure-foundry',
  'openrouter',
  'self-hosted',
];
/** These need the address of the service; for the others it is an optional proxy. */
const NEEDS_URL = new Set<LlmProvider>(['self-hosted', 'azure-openai', 'azure-foundry']);
const AZURE_VERSION: Partial<Record<LlmProvider, string>> = {
  'azure-openai': '2024-10-21',
  'azure-foundry': '2024-05-01-preview',
};
export const DEFAULT_PARAMS: LlmParams = {
  temperature: 0.2,
  maxTokens: 8000,
  timeoutSeconds: 120,
  concurrency: 3,
  noReasoning: true,
};

type Form = Omit<LlmProfileInput, 'key'>;

function initial(p: LlmProfile | null): Form {
  if (p)
    return {
      name: p.name,
      provider: p.provider,
      baseUrl: p.baseUrl,
      apiVersion: p.apiVersion,
      model: p.model,
      priority: p.priority,
      weight: p.weight,
      enabled: p.enabled,
      params: { ...p.params },
    };
  return {
    name: c().providers.openai ?? 'OpenAI',
    provider: 'openai',
    baseUrl: '',
    apiVersion: '',
    model: '',
    priority: 1,
    weight: 1,
    enabled: true,
    params: { ...DEFAULT_PARAMS },
  };
}

/**
 * What the form sends (docs/18-llm.md, "設定檔"): the key is left out when nothing was typed and
 * "clear" was not pressed (the stored one stays), null when it is to be cleared, the text otherwise.
 */
export function profileBody(form: Form, keyText: string, clearKey: boolean): LlmProfileInput {
  const body: LlmProfileInput = {
    ...form,
    name: form.name.trim(),
    baseUrl: form.baseUrl.trim(),
    apiVersion: form.provider in AZURE_VERSION ? form.apiVersion.trim() : '',
    model: form.model.trim(),
  };
  if (clearKey) body.key = null;
  else if (keyText.trim()) body.key = keyText.trim();
  return body;
}

/** A field's code as a sentence; the server's range checks (TOO_BIG, TOO_SMALL) read as "out of range". */
const fieldMsg = (code: string | undefined) => {
  if (!code) return null;
  const k = code === 'TOO_BIG' || code === 'TOO_SMALL' ? 'RANGE' : code;
  return c().fields[k] ?? c().fields.INVALID;
};

/** Why a service gave no model list: the same sentences as the test button (AUTH, UNREACHABLE…). */
const listFailure = (code: string | undefined) => {
  const m = code ? c().checks[code] : undefined;
  return typeof m === 'string' ? m : fieldMsg(code);
};

export function LlmProfileDialog({
  profile,
  onClose,
  onSaved,
}: {
  profile: LlmProfile | null;
  onClose: () => void;
  onSaved: (p: LlmProfile) => void;
}) {
  const [form, setForm] = useState<Form>(() => initial(profile));
  const [keyText, setKeyText] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelNote, setModelNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [fetching, setFetching] = useState(false);
  const [testing, setTesting] = useState(false);
  const [check, setCheck] = useState<{ text: string; ok: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const listId = useId();
  // Names the person has not changed follow the provider, so a new profile is named sensibly.
  const [nameTouched, setNameTouched] = useState(!!profile);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setParam = <K extends keyof LlmParams>(k: K, v: LlmParams[K]) =>
    setForm((f) => ({ ...f, params: { ...f.params, [k]: v } }));
  const changeProvider = (p: LlmProvider) => {
    setForm((f) => ({
      ...f,
      provider: p,
      apiVersion: AZURE_VERSION[p] ?? '',
      name: nameTouched ? f.name : (c().providers[p] ?? p).replace(/（.*$/, ''),
    }));
    setModels([]);
    setModelNote(null);
    setCheck(null);
  };
  const needsUrl = NEEDS_URL.has(form.provider);
  const azure = form.provider in AZURE_VERSION;
  const body = () => profileBody(form, keyText, clearKey);
  const withId = profile ? { profileId: profile.id } : {};

  const fetchModels = async () => {
    setFetching(true);
    setModelNote(null);
    try {
      const b = body();
      const r = await post<{ models: string[] }>('/api/admin/llm/models', {
        ...withId,
        provider: b.provider,
        baseUrl: b.baseUrl,
        apiVersion: b.apiVersion,
        ...(typeof b.key === 'string' ? { key: b.key } : {}),
      });
      setModels(r.models);
      setModelNote(
        r.models.length
          ? { text: c().modelsFound(r.models.length), bad: false }
          : { text: form.provider === 'azure-openai' ? c().modelsAzure : c().modelsNone, bad: false },
      );
    } catch (err) {
      const f = asFailure(err);
      const code = fieldCodes(f);
      setModelNote({
        text:
          form.provider === 'azure-openai'
            ? c().modelsAzure
            : (listFailure(Object.values(code)[0]) ??
              (t.errors[f.code as keyof typeof t.errors] || t.common.unknownError)),
        bad: form.provider !== 'azure-openai',
      });
    } finally {
      setFetching(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setCheck(null);
    try {
      const r = await post<LlmCheck>('/api/admin/llm/test', { ...body(), ...withId });
      const msg = c().checks[r.code];
      setCheck({
        ok: r.ok,
        text:
          typeof msg === 'function'
            ? msg((r.ms / 1000).toFixed(1), (r.reply ?? '').slice(0, 120))
            : (msg ?? t.common.unknownError),
      });
    } catch (err) {
      const f = asFailure(err);
      const codes = fieldCodes(f);
      if (Object.keys(codes).length) setErrors(codes);
      setCheck({ ok: false, text: f.code === 'NETWORK' ? t.common.offline : t.common.unknownError });
    } finally {
      setTesting(false);
    }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    setFormError(null);
    try {
      const saved = profile
        ? await put<LlmProfile>(`/api/admin/llm/profiles/${profile.id}`, body())
        : await post<LlmProfile>('/api/admin/llm/profiles', body());
      onSaved(saved);
    } catch (err) {
      const f = asFailure(err);
      const codes = fieldCodes(f);
      if (Object.keys(codes).length) setErrors(codes);
      else setFormError(f.code === 'NETWORK' ? t.common.offline : t.common.unknownError);
    } finally {
      setSaving(false);
    }
  };

  const urlField = (label: string, help: string) => (
    <Field label={label} help={help} error={fieldMsg(errors.baseUrl)}>
      {(id, note) => (
        <input
          id={id}
          aria-describedby={note}
          aria-invalid={!!errors.baseUrl}
          className="mono"
          type="url"
          inputMode="url"
          spellCheck={false}
          autoCapitalize="none"
          placeholder="https://"
          value={form.baseUrl}
          onChange={(e) => set('baseUrl', e.target.value)}
        />
      )}
    </Field>
  );
  const num = (k: 'priority' | 'weight', label: string, help: string, min: number, max: number) => (
    <Field label={label} help={help} error={fieldMsg(errors[k])}>
      {(id, note) => (
        <input
          id={id}
          aria-describedby={note}
          aria-invalid={!!errors[k]}
          type="number"
          min={min}
          max={max}
          step={1}
          value={form[k]}
          onChange={(e) => set(k, Number(e.target.value))}
        />
      )}
    </Field>
  );
  const paramNum = (
    k: 'temperature' | 'maxTokens' | 'timeoutSeconds' | 'concurrency',
    label: string,
    help: string,
    min: number,
    max: number,
    step: number,
  ) => {
    const err = errors[`params.${k}`];
    return (
      <Field label={label} help={help} error={fieldMsg(err)}>
        {(id, note) => (
          <input
            id={id}
            aria-describedby={note}
            aria-invalid={!!err}
            type="number"
            min={min}
            max={max}
            step={step}
            value={form.params[k]}
            onChange={(e) => setParam(k, Number(e.target.value))}
          />
        )}
      </Field>
    );
  };

  return (
    <Modal title={profile ? c().dialogEdit(profile.name) : c().dialogNew} onClose={onClose} busy={saving} wide>
      <form className="stack-form" onSubmit={save} noValidate>
        <Field label={c().name} error={fieldMsg(errors.name)}>
          {(id, note) => (
            <input
              id={id}
              aria-describedby={note}
              aria-invalid={!!errors.name}
              maxLength={60}
              value={form.name}
              onChange={(e) => {
                setNameTouched(true);
                set('name', e.target.value);
              }}
            />
          )}
        </Field>
        <Field label={c().provider} error={fieldMsg(errors.provider)}>
          {(id, note) => (
            <select
              id={id}
              aria-describedby={note}
              value={form.provider}
              onChange={(e) => changeProvider(e.target.value as LlmProvider)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {c().providers[p]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {needsUrl && urlField(c().baseUrl, c().baseUrlHelp[form.provider] ?? '')}
        {azure && (
          <Field label={c().apiVersion} error={fieldMsg(errors.apiVersion)}>
            {(id, note) => (
              <input
                id={id}
                aria-describedby={note}
                className="mono"
                spellCheck={false}
                value={form.apiVersion}
                onChange={(e) => set('apiVersion', e.target.value)}
              />
            )}
          </Field>
        )}
        <Field label={c().key} help={clearKey ? c().keyWillClear : c().keyHelp} error={fieldMsg(errors.key)}>
          {(id, note) => (
            <div className="inline">
              <input
                id={id}
                aria-describedby={note}
                type="password"
                autoComplete="off"
                spellCheck={false}
                disabled={clearKey}
                placeholder={profile?.keySet && !clearKey ? c().keyKeep : ''}
                value={keyText}
                onChange={(e) => setKeyText(e.target.value)}
              />
              {profile?.keySet && (
                <button
                  type="button"
                  aria-pressed={clearKey}
                  onClick={() => {
                    setClearKey(!clearKey);
                    setKeyText('');
                  }}
                >
                  {clearKey ? c().undoClear : c().clearKey}
                </button>
              )}
            </div>
          )}
        </Field>
        <Field
          label={form.provider === 'azure-openai' ? c().modelAzure : c().model}
          help={modelNote ? undefined : c().modelHelp}
          error={fieldMsg(errors.model)}
        >
          {(id, note) => (
            <>
              <div className="inline">
                <input
                  id={id}
                  aria-describedby={note}
                  aria-invalid={!!errors.model}
                  className="mono"
                  list={listId}
                  spellCheck={false}
                  autoCapitalize="none"
                  value={form.model}
                  onChange={(e) => set('model', e.target.value)}
                />
                <button type="button" disabled={fetching} onClick={() => void fetchModels()}>
                  {fetching ? c().fetchingModels : c().fetchModels}
                </button>
              </div>
              <datalist id={listId}>
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {modelNote && (
                <small className={modelNote.bad ? 'err' : undefined} aria-live="polite">
                  {modelNote.text}
                </small>
              )}
            </>
          )}
        </Field>
        <div className="row2">
          {num('priority', c().priority, c().priorityHelp, 1, 9)}
          {num('weight', c().weight, c().weightHelp, 1, 100)}
        </div>
        <Switch checked={form.enabled} onChange={(v) => set('enabled', v)} label={c().enabled} />
        <details>
          <summary>{c().params}</summary>
          {!needsUrl && urlField(c().proxyUrl, c().proxyUrlHelp)}
          <div className="row2">
            {paramNum('temperature', c().temperature, c().temperatureHelp, 0, 2, 0.1)}
            {paramNum('maxTokens', c().maxTokens, c().maxTokensHelp, 256, 32000, 256)}
            {paramNum('timeoutSeconds', c().timeout, c().timeoutHelp, 10, 600, 10)}
            {paramNum('concurrency', c().concurrency, c().concurrencyHelp, 1, 16, 1)}
          </div>
          <label className="chk">
            <input
              type="checkbox"
              checked={form.params.noReasoning}
              onChange={(e) => setParam('noReasoning', e.target.checked)}
            />
            {c().noReasoning}
          </label>
        </details>
        {check && (
          <p className={check.ok ? 'good' : 'bad'} aria-live="polite">
            {check.text}
          </p>
        )}
        {formError && (
          <p className="bad" role="alert">
            {formError}
          </p>
        )}
        <div className="modal-act">
          <button type="button" className="push" disabled={testing} onClick={() => void test()}>
            {testing ? c().testing : c().test}
          </button>
          <button type="button" disabled={saving} onClick={onClose}>
            {c().cancel}
          </button>
          <button type="submit" className="primary" disabled={saving}>
            {saving ? c().saving : c().save}
          </button>
        </div>
      </form>
    </Modal>
  );
}
