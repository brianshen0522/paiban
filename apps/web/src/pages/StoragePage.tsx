import type { StorageItem } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Banner, ConfirmInline, PageHead, Skeleton } from '../components/Bits';
import { useToast } from '../components/Toasts';
import { UsageBar, UsageLegend } from '../components/Usage';
import { t } from '../copy/zh-TW';
import { del } from '../lib/api';
import { bytes } from '../lib/format';
import { keys, useExports, useMe, useStorage } from '../lib/queries';
import { ExportRow } from './workspace/ExportTab';

/** docs/10-storage.md, "介面上的呈現" (the page everyone sees). */
export function StoragePage() {
  const s = useStorage();
  if (s.isError)
    return (
      <>
        <PageHead title={t.storage.title} />
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => s.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      </>
    );
  if (!s.data)
    return (
      <>
        <PageHead title={t.storage.title} />
        <Skeleton />
      </>
    );
  const { usage, items } = s.data;
  const films = items.filter((i) => i.kind !== 'preview');
  const previews = new Map(items.filter((i) => i.kind === 'preview').map((i) => [i.torrentId, i.bytes]));
  return (
    <>
      <PageHead title={t.storage.title} />
      <UsageNotice usage={usage} />
      <section className="card">
        <div className="ubig">
          <b className="mono">{bytes(usage.usedBytes)}</b>
          <span>{t.storage.used(bytes(usage.usedBytes), bytes(usage.limitBytes))}</span>
          <span>· {t.storage.free(bytes(usage.freeBytes))}</span>
        </div>
        <UsageBar usage={usage} big />
        <UsageLegend usage={usage} />
      </section>
      <section className="card">
        <h2>{t.storage.rulesTitle}</h2>
        <ul className="rules">
          {t.storage.rules.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2>{t.storage.mine}</h2>
        {films.length === 0 ? (
          <p className="sub">{t.storage.mineEmpty}</p>
        ) : (
          <div className="tw">
            <table>
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
                {films.map((i) => (
                  <MyItem key={`${i.kind}:${i.id}`} item={i} preview={previews.get(i.torrentId) ?? 0} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <MyExports />
    </>
  );
}

/** "我建立的匯出檔": after a film is removed, this is the only place its exports can be downloaded. */
function MyExports() {
  const q = useExports();
  return (
    <section className="card">
      <h2>{t.storage.myExports}</h2>
      {q.isError ? (
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => q.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      ) : !q.data ? (
        <p className="sub">{t.common.loading}</p>
      ) : q.data.length === 0 ? (
        <p className="sub">{t.storage.myExportsEmpty}</p>
      ) : (
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
                {q.data.map((e) => (
                  <ExportRow key={e.id} e={e} showFilm />
                ))}
              </tbody>
            </table>
          </div>
          <p className="sub">{t.storage.myExportsNote}</p>
        </>
      )}
    </section>
  );
}

export function UsageNotice({ usage }: { usage: import('@paiban/shared').Usage }) {
  if (usage.limitBytes === 0) return <Banner tone="bad">{t.storage.noLimit}</Banner>;
  if (usage.over) return <Banner tone="bad">{t.storage.over}</Banner>;
  if (usage.freeBytes < 2 * 1024 ** 3)
    return <Banner tone="warn">{t.storage.nearlyFull(bytes(usage.freeBytes))}</Banner>;
  return null;
}

function MyItem({ item, preview }: { item: StorageItem; preview: number }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = item.holders.filter((h) => h.id !== me?.user.id).map((h) => h.displayName);
  const text =
    item.kind === 'reserved'
      ? t.storage.confirmUnfinished
      : item.kind === 'partial'
        ? t.storage.confirmPartial(bytes(item.bytes))
        : others.length
          ? t.storage.confirmShared(others.join('、'))
          : t.storage.confirmLast(
              bytes(item.bytes + preview + (item.filmExports?.bytes ?? 0)),
              item.filmExports?.count ?? 0,
            );
  const button =
    item.kind === 'reserved'
      ? t.storage.btnCancelDownload
      : item.kind === 'partial'
        ? t.storage.btnRemove
        : others.length
          ? t.storage.btnLeave
          : t.storage.btnDelete;

  const remove = async () => {
    setBusy(true);
    try {
      const r = await del<{ deleted: boolean }>(`/api/torrents/${item.torrentId}/hold`);
      toast(r.deleted ? t.downloads.removed : t.downloads.removedShared);
      void qc.invalidateQueries({ queryKey: keys.storage });
      void qc.invalidateQueries({ queryKey: ['torrents'] });
      void qc.invalidateQueries({ queryKey: keys.library });
      void qc.invalidateQueries({ queryKey: keys.exports });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <>
      <tr>
        <td>{t.storage.kinds[item.kind]}</td>
        <td className="rel">
          {item.movieTitle} <span className="sub-i">{item.version}</span>
          {preview > 0 && <div className="sub">{t.storage.previewExtra(bytes(preview))}</div>}
        </td>
        <td className="num">{bytes(item.bytes)}</td>
        <td>{others.length ? item.holders.map((h) => h.displayName).join('、') : t.storage.onlyYou}</td>
        <td className="act">
          <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
            {button}
          </button>
        </td>
      </tr>
      {confirm && (
        <tr className="blocked">
          <td colSpan={5}>
            <ConfirmInline
              text={text}
              confirmLabel={button}
              busy={busy}
              onConfirm={remove}
              onCancel={() => setConfirm(false)}
            />
          </td>
        </tr>
      )}
    </>
  );
}
