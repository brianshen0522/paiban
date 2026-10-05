import type { Usage } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Banner, Field, PageHead, Skeleton } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { UsageBar, UsageLegend } from '../../components/Usage';
import { t } from '../../copy/zh-TW';
import { ApiFailure, put } from '../../lib/api';
import { bytes } from '../../lib/format';
import { keys, useAdminStorage } from '../../lib/queries';
import { UsageNotice } from '../StoragePage';

const GB = 1024 ** 3;

/** docs/10-storage.md, "上限的驗證", and the list of every item. Force deletion comes later. */
export function StorageAdminPage() {
  const s = useAdminStorage();
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (s.data) setValue(String(Math.round(s.data.usage.limitBytes / GB)));
  }, [s.data]);

  if (s.isError)
    return (
      <>
        <PageHead title={t.admin.storage.title} />
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
        </Banner>
      </>
    );
  if (!s.data)
    return (
      <>
        <PageHead title={t.admin.storage.title} />
        <Skeleton />
      </>
    );
  const { usage, disk, items } = s.data;
  const n = /^\s*\d+\s*$/.test(value) ? Number(value) : Number.NaN;
  const maxGb = Math.floor(disk.maxLimitBytes / GB);
  const live =
    Number.isNaN(n) || n < 1
      ? { error: true, text: t.fields.notWholeGb }
      : n * GB > disk.maxLimitBytes
        ? { error: true, text: t.fields.aboveDisk(`${maxGb} GB`) }
        : n * GB === usage.limitBytes
          ? {
              error: false,
              text: t.admin.storage.limitHelp(bytes(disk.totalBytes), bytes(disk.reserveBytes), `${maxGb} GB`),
            }
          : n * GB < usage.usedBytes
            ? { error: false, warn: true, text: t.admin.storage.limitBelow(bytes(usage.usedBytes), bytes(n * GB)) }
            : { error: false, text: t.admin.storage.limitAfter(bytes(n * GB - usage.usedBytes)) };
  const below = !Number.isNaN(n) && n * GB < usage.usedBytes;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (live.error) {
      setError(live.text);
      return;
    }
    if (n * GB === usage.limitBytes) {
      toast(t.admin.storage.unchanged);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const u = await put<Usage>('/api/admin/storage/limit', { limitBytes: n * GB });
      toast(u.over ? t.admin.storage.savedOver(bytes(u.limitBytes)) : t.admin.storage.saved(bytes(u.limitBytes)));
      void qc.invalidateQueries({ queryKey: keys.adminStorage });
      void qc.invalidateQueries({ queryKey: keys.storage });
    } catch (err) {
      const code =
        err instanceof ApiFailure && err.details && 'fields' in err.details ? err.details.fields.limitBytes : undefined;
      setError(
        code === 'ABOVE_DISK' ? t.fields.aboveDisk(`${maxGb} GB`) : code ? t.fields.notWholeGb : t.common.unknownError,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHead title={t.admin.storage.title} />
      <UsageNotice usage={usage} />
      <section className="card">
        <div className="ubig">
          <b className="mono">{bytes(usage.usedBytes)}</b>
          <span>{t.storage.used(bytes(usage.usedBytes), bytes(usage.limitBytes))}</span>
        </div>
        <UsageBar usage={usage} big />
        <UsageLegend usage={usage} />
        <form className="frow limit" onSubmit={save} noValidate>
          <Field
            label={t.admin.storage.limit}
            help={
              error ? undefined : (
                <span className={live.error ? 'err' : 'warn' in live ? 'warnt' : ''}>{live.text}</span>
              )
            }
            error={error}
          >
            {(id, note) => (
              <input
                id={id}
                aria-describedby={note}
                aria-invalid={live.error || !!error}
                inputMode="numeric"
                className="narrow-input"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
              />
            )}
          </Field>
          <button type="submit" className={below ? 'danger' : 'primary'} disabled={saving}>
            {below ? t.admin.storage.saveAnyway : t.common.save}
          </button>
        </form>
      </section>
      <section className="card">
        <h2>{t.admin.storage.items}</h2>
        {items.length === 0 ? (
          <p className="sub">{t.admin.storage.itemsEmpty}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{t.storage.cols.kind}</th>
                  <th>{t.storage.cols.name}</th>
                  <th className="num">{t.storage.cols.size}</th>
                  <th>{t.storage.cols.holders}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={`${i.kind}:${i.id}`}>
                    <td>{t.storage.kinds[i.kind]}</td>
                    <td className="rel">
                      {i.movieTitle} <span className="sub-i">{i.version}</span>
                    </td>
                    <td className="num">{bytes(i.bytes)}</td>
                    <td>
                      {i.holders.length ? i.holders.map((h) => h.displayName).join('、') : t.admin.storage.noHolders}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
