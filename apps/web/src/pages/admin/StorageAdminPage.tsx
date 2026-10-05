import type { StorageItem, Usage } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Banner, ConfirmInline, Field, PageHead, Skeleton } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { UsageBar, UsageLegend } from '../../components/Usage';
import { t } from '../../copy/zh-TW';
import { ApiFailure, del, put } from '../../lib/api';
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
            <table className="rtable">
              <thead>
                <tr>
                  <th>{t.storage.cols.kind}</th>
                  <th>{t.storage.cols.name}</th>
                  <th className="num">{t.storage.cols.size}</th>
                  <th>{t.storage.cols.holders}</th>
                  <th className="act">{t.storage.cols.action}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <AdminItemRow
                    key={`${i.kind}:${i.id}`}
                    item={i}
                    hasPreview={
                      i.kind === 'movie' && items.some((x) => x.kind === 'preview' && x.torrentId === i.torrentId)
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

/** One item with the administrator's force delete (docs/10-storage.md, "確認的文字"). */
function AdminItemRow({ item, hasPreview }: { item: StorageItem; hasPreview: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const names = item.holders.map((h) => h.displayName).join('、') || t.forceDelete.nobody;
  const size = bytes(item.bytes);
  const text =
    item.kind === 'movie'
      ? item.holders.length
        ? t.forceDelete.movieHeld(item.holders.length, size, hasPreview)
        : t.forceDelete.movieNobody(size, hasPreview)
      : item.kind === 'reserved'
        ? t.forceDelete.reserved(names)
        : item.kind === 'partial'
          ? t.forceDelete.partial(size)
          : item.kind === 'preview'
            ? t.forceDelete.preview
            : t.forceDelete.export(names, size);

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await del<{ freedBytes: number }>(`/api/admin/storage/items/${item.kind}/${item.id}`);
      toast(r.freedBytes > 0 ? t.forceDelete.done(bytes(r.freedBytes)) : t.forceDelete.doneNoSize);
    } catch (err) {
      setError(
        err instanceof ApiFailure && (err.code === 'TORRENT_STATE' || err.code === 'NOT_FOUND')
          ? t.forceDelete.changed
          : t.common.unknownError,
      );
    } finally {
      setBusy(false);
      setConfirm(false);
      void qc.invalidateQueries({ queryKey: keys.adminStorage });
      void qc.invalidateQueries({ queryKey: keys.storage });
    }
  };

  return (
    <>
      <tr>
        <td className="lead">{t.storage.kinds[item.kind]}</td>
        <td className="rel" data-label={t.storage.cols.name}>
          {item.fileName ?? item.movieTitle}{' '}
          <span className="sub-i">{item.kind === 'export' ? item.movieTitle : item.version}</span>
        </td>
        <td className="num" data-label={t.storage.cols.size}>
          {size}
        </td>
        <td data-label={t.storage.cols.holders}>{item.holders.length ? names : t.admin.storage.noHolders}</td>
        <td className="act">
          <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
            {t.forceDelete.button}
          </button>
        </td>
      </tr>
      {(confirm || error) && (
        <tr className="blocked">
          <td colSpan={5}>
            {confirm && (
              <ConfirmInline
                text={text}
                confirmLabel={t.forceDelete.button}
                busy={busy}
                onConfirm={remove}
                onCancel={() => setConfirm(false)}
              />
            )}
            {error && (
              <Banner tone="warn">
                <span>{error}</span>
                <button type="button" onClick={() => setError(null)}>
                  {t.common.gotIt}
                </button>
              </Banner>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
