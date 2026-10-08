import type { Settings } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Banner, Field, PageHead, Skeleton, Switch } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy';
import { ApiFailure, patch } from '../../lib/api';
import { keys, useAdminSettings } from '../../lib/queries';
import { fieldMessage } from './fieldMessages';

type Form = {
  maxActive: string;
  maxPerUser: string;
  downloadLimitKB: string;
  uploadLimitKB: string;
  stallMinutes: string;
  trackers: string;
  seedMode: Settings['downloads']['seedMode'];
  analyzeAuto: boolean;
  proxyAuto: boolean;
  proxyResolution: Settings['media']['proxyResolution'];
};

const toForm = (s: Settings): Form => ({
  maxActive: String(s.downloads.maxActive),
  maxPerUser: String(s.downloads.maxPerUser),
  downloadLimitKB: String(s.downloads.downloadLimitKB),
  uploadLimitKB: String(s.downloads.uploadLimitKB),
  stallMinutes: String(s.downloads.stallMinutes),
  trackers: s.downloads.trackers.join('\n'),
  seedMode: s.downloads.seedMode,
  analyzeAuto: s.media.analyzeAuto,
  proxyAuto: s.media.proxyAuto,
  proxyResolution: s.media.proxyResolution,
});

const num = (v: string) => (/^\s*\d+\s*$/.test(v) ? Number(v) : Number.NaN);

/** docs/11-pages.md, "下載設定": one form with an unsaved-changes bar; ports are read-only (D31). */
export function DownloadSettingsPage() {
  const s = useAdminSettings();
  const qc = useQueryClient();
  const toast = useToast();
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (s.data && !form) setForm(toForm(s.data.settings));
  }, [s.data, form]);

  if (s.isError)
    return (
      <>
        <PageHead title={t.admin.downloads.title} />
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
        </Banner>
      </>
    );
  if (!s.data || !form)
    return (
      <>
        <PageHead title={t.admin.downloads.title} />
        <Skeleton lines={6} />
      </>
    );
  const saved = toForm(s.data.settings);
  const dirty = JSON.stringify(saved) !== JSON.stringify(form);
  const info = s.data.info;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body = {
        downloads: {
          maxActive: num(form.maxActive),
          maxPerUser: num(form.maxPerUser),
          downloadLimitKB: num(form.downloadLimitKB),
          uploadLimitKB: num(form.uploadLimitKB),
          stallMinutes: num(form.stallMinutes),
          trackers: form.trackers
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
          seedMode: form.seedMode,
        },
        media: { analyzeAuto: form.analyzeAuto, proxyAuto: form.proxyAuto, proxyResolution: form.proxyResolution },
      };
      const res = await patch<{ settings: Settings }>('/api/admin/settings', body);
      qc.setQueryData(keys.adminSettings, { ...s.data, settings: res.settings });
      setForm(toForm(res.settings));
      toast(t.admin.downloads.saved);
      void qc.invalidateQueries({ queryKey: keys.me });
    } catch (err) {
      if (err instanceof ApiFailure && err.details && 'fields' in err.details) {
        const max = num(form.maxActive);
        const out: Record<string, string> = {};
        for (const [k, code] of Object.entries(err.details.fields))
          out[k] = fieldMessage(k, code, { maxActive: Number.isNaN(max) ? s.data.settings.downloads.maxActive : max });
        setErrors(out);
        setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      } else setErrors({ _: t.common.unknownError });
    } finally {
      setSaving(false);
    }
  };

  const numberField = (key: keyof Form, apiKey: string, label: string, help: string) => (
    <Field label={label} help={help} error={errors[apiKey] ?? null}>
      {(id, note) => (
        <input
          id={id}
          aria-describedby={note}
          aria-invalid={!!errors[apiKey]}
          inputMode="numeric"
          value={String(form[key])}
          onChange={(e) => set(key, e.target.value as never)}
        />
      )}
    </Field>
  );

  return (
    <>
      <PageHead title={t.admin.downloads.title} />
      <form className="stackwide" onSubmit={save} ref={formRef} noValidate>
        <section className="card">
          <h2>{t.admin.downloads.amount}</h2>
          <div className="fgrid">
            {numberField(
              'maxActive',
              'downloads.maxActive',
              t.admin.downloads.maxActive,
              t.admin.downloads.maxActiveHelp,
            )}
            {numberField(
              'maxPerUser',
              'downloads.maxPerUser',
              t.admin.downloads.maxPerUser,
              t.admin.downloads.maxPerUserHelp,
            )}
            {numberField(
              'downloadLimitKB',
              'downloads.downloadLimitKB',
              t.admin.downloads.downloadLimit,
              t.admin.downloads.limitHelp,
            )}
            {numberField(
              'uploadLimitKB',
              'downloads.uploadLimitKB',
              t.admin.downloads.uploadLimit,
              t.admin.downloads.limitHelp,
            )}
            {numberField(
              'stallMinutes',
              'downloads.stallMinutes',
              t.admin.downloads.stall,
              t.admin.downloads.stallHelp,
            )}
          </div>
        </section>
        <section className="card">
          <h2>{t.admin.downloads.connection}</h2>
          <p className="sub">{t.admin.downloads.ports(info.torrentPort, info.torrentDhtPort)}</p>
          <p>{info.incoming.seen ? t.admin.downloads.incomingSeen : t.admin.downloads.incomingNone}</p>
          <Field
            label={t.admin.downloads.trackers}
            help={t.admin.downloads.trackersHelp}
            error={errors['downloads.trackers'] ?? null}
          >
            {(id, note) => (
              <textarea
                id={id}
                aria-describedby={note}
                aria-invalid={!!errors['downloads.trackers']}
                rows={4}
                spellCheck={false}
                className="mono"
                value={form.trackers}
                onChange={(e) => set('trackers', e.target.value)}
              />
            )}
          </Field>
        </section>
        <section className="card">
          <h2>{t.admin.downloads.seeding}</h2>
          <fieldset className="radios">
            <legend className="sr-only">{t.admin.downloads.seeding}</legend>
            <label className="chk">
              <input
                type="radio"
                name="seed"
                checked={form.seedMode === 'stop'}
                onChange={() => set('seedMode', 'stop')}
              />
              {t.admin.downloads.seedStop}
            </label>
            <label className="chk">
              <input
                type="radio"
                name="seed"
                checked={form.seedMode === 'ratio'}
                onChange={() => set('seedMode', 'ratio')}
              />
              {t.admin.downloads.seedRatio}
            </label>
          </fieldset>
        </section>
        <section className="card">
          <h2>{t.admin.downloads.after}</h2>
          <Switch
            checked={form.analyzeAuto}
            onChange={(v) => set('analyzeAuto', v)}
            label={t.admin.downloads.analyzeAuto}
          />
          <Switch checked={form.proxyAuto} onChange={(v) => set('proxyAuto', v)} label={t.admin.downloads.proxyAuto} />
          <Field label={t.admin.downloads.proxyRes} help={t.admin.downloads.proxyNote}>
            {(id, note) => (
              <select
                id={id}
                aria-describedby={note}
                value={form.proxyResolution}
                onChange={(e) => set('proxyResolution', e.target.value as Form['proxyResolution'])}
              >
                <option value="480p">{t.admin.downloads.res480}</option>
                <option value="720p">{t.admin.downloads.res720}</option>
              </select>
            )}
          </Field>
        </section>
        {errors._ && <Banner tone="bad">{errors._}</Banner>}
        <div className="savebar frow">
          <button type="submit" className="primary" disabled={!dirty || saving}>
            {t.common.save}
          </button>
          <button type="button" disabled={!dirty} onClick={() => setForm(saved)}>
            {t.admin.downloads.revert}
          </button>
          {dirty && <span className="warnt">{t.admin.downloads.unsaved}</span>}
        </div>
      </form>
    </>
  );
}
