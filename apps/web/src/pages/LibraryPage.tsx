import type { LibraryItem } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Banner, Chip, ConfirmInline, Empty, PageHead, Skeleton } from '../components/Bits';
import { Poster } from '../components/Poster';
import { useToast } from '../components/Toasts';
import { t } from '../copy/zh-TW';
import { del } from '../lib/api';
import { bytes, versionLabel } from '../lib/format';
import { keys, useLibrary, useMe } from '../lib/queries';

/**
 * docs/11-pages.md, "片庫". Subtitles, sync and export arrive in later phases; the cards already
 * show the three steps and removing a film works.
 */
export function LibraryPage() {
  const lib = useLibrary();
  return (
    <>
      <PageHead title={t.library.title} lead={t.library.lead} />
      {lib.isError ? (
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => lib.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      ) : !lib.data ? (
        <Skeleton lines={4} />
      ) : lib.data.length === 0 ? (
        <Empty title={t.library.empty} hint={t.library.emptyHint}>
          <Link className="btn" to="/search">
            {t.pages.toSearch}
          </Link>
        </Empty>
      ) : (
        <div className="libs">
          {lib.data.map((item) => (
            <Card key={item.torrent.id} item={item} />
          ))}
        </div>
      )}
    </>
  );
}

function Card({ item }: { item: LibraryItem }) {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe().data;
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const x = item.torrent;
  const others = x.holders.filter((h) => h.id !== me?.user.id).map((h) => h.displayName);
  const preview = x.media?.previewBytes ?? 0;

  const remove = async () => {
    setBusy(true);
    try {
      await del(`/api/torrents/${x.id}/hold`);
      toast(t.library.removed);
      void qc.invalidateQueries({ queryKey: keys.library });
      void qc.invalidateQueries({ queryKey: keys.storage });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };

  return (
    <article className="lib" id={x.id}>
      <Poster
        url={x.movie.posterUrl}
        title={x.movie.title}
        year={x.movie.year}
        runtimeMin={x.movie.runtimeMin}
        size="sm"
      />
      <div className="lib-main">
        <h2>{x.movie.title}</h2>
        <span className="sub">
          {x.movie.year} · {versionLabel(x.version)}
        </span>
        <ul className="flow">
          <li className="done">{t.library.stepVideo}</li>
          <li className={item.subtitles.confirmed > 0 ? 'done' : item.subtitles.total > 0 ? 'part' : ''}>
            {t.library.stepSubs}
          </li>
          <li className={item.exports > 0 ? 'done' : ''}>{t.library.stepExport}</li>
        </ul>
        <span className="sub">{others.length ? t.library.sharedWith(others.join('、')) : t.library.onlyYou}</span>
        {x.status === 'analyzing' && <Chip tone="info">{t.library.analyzing}</Chip>}
      </div>
      <div className="lib-act">
        <button type="button" aria-expanded={confirm} onClick={() => setConfirm(true)}>
          {t.library.remove}
        </button>
      </div>
      {confirm && (
        <div className="dl-confirm">
          <ConfirmInline
            text={
              others.length
                ? t.library.confirmShared(others.join('、'))
                : t.library.confirmLast(bytes(x.diskBytes), preview > 0 ? bytes(preview) : null)
            }
            confirmLabel={t.library.removeButton}
            busy={busy}
            onConfirm={remove}
            onCancel={() => setConfirm(false)}
          />
        </div>
      )}
    </article>
  );
}
