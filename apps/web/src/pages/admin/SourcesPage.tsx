import type { SourceCheck, SourceHealth } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Banner, Chip, Field, PageHead, Skeleton } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy/zh-TW';
import { ApiFailure, patch, post } from '../../lib/api';
import { relative } from '../../lib/format';
import { keys, useAdminSettings } from '../../lib/queries';
import { fieldMessage } from './fieldMessages';

/** docs/11-pages.md, "來源設定". For now only the YTS card; the subtitle sources come in phase 5. */
export function SourcesPage() {
  const s = useAdminSettings();
  return (
    <>
      <PageHead title={t.admin.sources.title} lead={t.admin.sources.lead} />
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
        <YtsCard baseUrl={s.data.settings.yts.baseUrl} health={s.data.sources.find((x) => x.id === 'yts')} />
      )}
    </>
  );
}

export function checkText(r: SourceCheck): string {
  switch (r.code) {
    case 'OK':
      return t.tests.ok((r.ms / 1000).toFixed(1));
    case 'REDIRECTED':
      return t.tests.REDIRECTED(String(r.data.host ?? ''));
    case 'NOT_CONFIGURED':
    case 'INVALID_KEY':
    case 'UNREACHABLE':
    case 'BAD_RESPONSE':
    case 'RATE_LIMITED':
      return t.tests[r.code];
  }
}

function YtsCard({ baseUrl, health }: { baseUrl: string; health: SourceHealth | undefined }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState(baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SourceCheck | null>(null);
  useEffect(() => setValue(baseUrl), [baseUrl]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await patch('/api/admin/settings', { yts: { baseUrl: value.trim() } });
      toast(t.admin.sources.saved);
      setResult(null);
      void qc.invalidateQueries({ queryKey: keys.adminSettings });
      void qc.invalidateQueries({ queryKey: ['search'] });
    } catch (err) {
      const code =
        err instanceof ApiFailure && err.details && 'fields' in err.details
          ? err.details.fields['yts.baseUrl']
          : undefined;
      setError(code ? fieldMessage('yts.baseUrl', code) : t.common.unknownError);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await post<SourceCheck>('/api/admin/sources/yts/test'));
      void qc.invalidateQueries({ queryKey: keys.adminSettings });
    } finally {
      setTesting(false);
    }
  };

  const state = health?.state ?? 'none';
  const tone = state === 'ok' ? 'ok' : state === 'warn' ? 'warn' : state === 'down' ? 'bad' : '';
  return (
    <section className="card">
      <h2>
        {t.admin.sources.yts}{' '}
        <Chip tone={tone}>{t.admin.sources.status[state === 'manual' || state === 'off' ? 'none' : state]}</Chip>
        {health?.checkedAt && <span className="sub">{t.admin.sources.checked(relative(health.checkedAt))}</span>}
      </h2>
      <form className="stack" onSubmit={save} noValidate>
        <Field label={t.admin.sources.ytsUrl} help={t.admin.sources.ytsHelp} error={error}>
          {(id, note) => (
            <input
              id={id}
              aria-describedby={note}
              aria-invalid={!!error}
              type="url"
              inputMode="url"
              spellCheck={false}
              autoCapitalize="none"
              placeholder="https://"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </Field>
        <div className="frow">
          <button type="submit" className="primary" disabled={saving || value.trim() === baseUrl}>
            {t.common.save}
          </button>
          <button type="button" onClick={test} disabled={testing || !baseUrl}>
            {t.admin.sources.test}
          </button>
          <span className={result ? (result.ok ? 'good' : 'bad') : 'sub'} aria-live="polite">
            {testing ? t.admin.sources.testing : result ? checkText(result) : ''}
          </span>
        </div>
      </form>
    </section>
  );
}
