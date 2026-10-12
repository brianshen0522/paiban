import type { Workspace } from '@paiban/shared';
import { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Chip, Empty } from '../../components/Bits';
import { t } from '../../copy';
import { Workbench } from '../../workbench/Workbench';
import { MediaPanel, previewSentence } from './MediaPanel';
import { langName, providerName } from './SubtitlesTab';

/** docs/11-pages.md, "Sync (09)": pick the subtitle, say what will play, then the workbench. */
export function SyncTab({ ws }: { ws: Workspace }) {
  const { subtitleId } = useParams();
  const navigate = useNavigate();
  const x = ws.item.torrent;
  const subs = ws.subtitles;

  // Pin the choice in the address, so confirming (which changes "the first unconfirmed") keeps it open.
  const auto = !subtitleId ? (subs.find((s) => s.status !== 'confirmed') ?? subs[0] ?? null) : null;
  useEffect(() => {
    if (auto) navigate(`/library/${x.id}/sync/${auto.id}`, { replace: true });
  }, [auto, navigate, x.id]);

  if (!subs.length)
    return (
      <Empty title={t.syncTab.none} hint={t.syncTab.noneHint}>
        <Link className="btn" to={`/library/${x.id}/subtitles`}>
          {t.syncTab.toSubs}
        </Link>
      </Empty>
    );

  // Without one in the address: the first one not yet confirmed, or else the first.
  const cur =
    subs.find((s) => s.id === subtitleId) ??
    (subtitleId ? null : (subs.find((s) => s.status !== 'confirmed') ?? subs[0] ?? null));

  return (
    <>
      <section className="card syncpick">
        <div className="frow">
          <div className="field">
            <label htmlFor="ws-sub">{t.syncTab.picking}</label>
            <select
              id="ws-sub"
              value={cur?.id ?? ''}
              onChange={(e) => navigate(`/library/${x.id}/sync/${e.target.value}`)}
            >
              {!cur && <option value="">—</option>}
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {t.syncTab.option(langName(s.language), providerName(s.provider), s.status === 'confirmed')}
                </option>
              ))}
            </select>
          </div>
          {cur &&
            (cur.status === 'confirmed' ? (
              <Chip tone="ok">{t.subs.confirmed(cur.score == null ? null : Math.round(cur.score * 100))}</Chip>
            ) : (
              <Chip tone="warn">{t.subs.draft(null)}</Chip>
            ))}
        </div>
        <p className="sub">
          {previewSentence(x)}
          {t.media.preview.suffix}
        </p>
        <MediaPanel torrent={x} />
      </section>
      {cur ? (
        <Workbench key={cur.id} ws={ws} subtitle={cur} />
      ) : (
        <Empty title={t.syncTab.gone}>
          <Link className="btn" to={`/library/${x.id}/sync`}>
            {t.common.back}
          </Link>
        </Empty>
      )}
    </>
  );
}
