import type { SyncCore } from '@paiban/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { memo, useEffect, useMemo, useRef } from 'react';
import { t } from '../copy';
import { displayText, type LineOp, overlapClass, shortTc } from './model';

type MappedCue = SyncCore.MappedCue;

export type ListMode = 'sync' | 'edit';

export type CueListProps = {
  shown: ReadonlyArray<MappedCue>;
  mapped: ReadonlyArray<MappedCue>;
  second: ReadonlyArray<string | null> | null;
  scores: Float32Array | null;
  query: string;
  sel: number;
  playing: number;
  isPlaying: boolean;
  /** Bumped when the selection moved by keyboard or from outside the list, so the row is scrolled into view. */
  reveal: number;
  mode: ListMode;
  onSelect: (i: number) => void;
  onSeek: (i: number) => void;
  onPlayLine: (i: number) => void;
  onAnchor: () => void;
  onSplit: () => void;
  onEdit: (i: number, op: LineOp) => void;
  onText: (i: number, text: string) => void;
  onTextFocus: () => void;
};

/**
 * The line list (docs/09-sync-workbench.md, "字幕清單"), virtualised: a film has over a thousand
 * lines. The playing line follows playback unless the person is working inside the list.
 */
export function CueList(p: CueListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const q = p.query.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!q) return p.mapped.map((_, i) => i);
    const out: number[] = [];
    p.mapped.forEach((m, i) => {
      const hay = `${m.text}\n${p.second?.[i] ?? ''}`.toLowerCase();
      if (hay.includes(q)) out.push(i);
    });
    return out;
  }, [p.mapped, p.second, q]);

  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 40,
    overscan: 8,
    getItemKey: (n) => rows[n] ?? n,
  });

  // Follow the playing line while playing, unless focus or the pointer is inside the list.
  const hovered = useRef(false);
  useEffect(() => {
    if (!p.isPlaying || p.playing < 0) return;
    const el = scroller.current;
    if (!el || hovered.current || el.contains(document.activeElement)) return;
    const n = rows.indexOf(p.playing);
    if (n >= 0) v.scrollToIndex(n, { align: 'auto' });
  }, [p.playing, p.isPlaying, rows, v]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only when asked to reveal
  useEffect(() => {
    const n = rows.indexOf(p.sel);
    if (n >= 0) v.scrollToIndex(n, { align: 'auto' });
  }, [p.reveal]);

  return (
    <div
      className="cues-scroll"
      ref={scroller}
      onPointerEnter={() => (hovered.current = true)}
      onPointerLeave={() => (hovered.current = false)}
    >
      {rows.length === 0 ? (
        <p className="cue-empty">{t.bench.noMatch(p.query)}</p>
      ) : (
        <ol className="cue-list" style={{ height: v.getTotalSize() }}>
          {v.getVirtualItems().map((it) => {
            const i = rows[it.index] ?? 0;
            return (
              <li
                key={it.key}
                data-index={it.index}
                ref={v.measureElement}
                className="cue-slot"
                style={{ transform: `translateY(${it.start}px)` }}
              >
                <Row i={i} {...p} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

const Row = memo(function Row({
  i,
  shown,
  mapped,
  second,
  scores,
  sel,
  playing,
  mode,
  onSelect,
  onSeek,
  onPlayLine,
  onAnchor,
  onSplit,
  onEdit,
  onText,
  onTextFocus,
}: CueListProps & { i: number }) {
  const m = mapped[i];
  const c = shown[i];
  if (!m || !c) return null;
  const v = scores ? (scores[i] ?? 0) : null;
  const selected = i === sel;
  const cls = `cue-row${selected ? ' sel' : ''}${i === playing ? ' now' : ''}${m.deleted ? ' del' : ''}`;
  const extra = second?.[i];
  return (
    <div className={cls}>
      <span className="n mono" aria-hidden="true">
        {i + 1}
      </span>
      <button type="button" className="t mono" title={t.bench.jump} onClick={() => onSeek(i)}>
        {shortTc(c.start)}
      </button>
      <button
        type="button"
        className="x"
        aria-pressed={selected}
        aria-label={`${i + 1} ${displayText(m.text)}`}
        onClick={() => onSelect(i)}
      >
        {displayText(m.text)}
        {extra && <small>{displayText(extra)}</small>}
      </button>
      <i
        className={`dot${v == null ? '' : ` ${overlapClass(v)}`}`}
        title={v == null ? t.bench.noSpeechDot : t.bench.overlap(Math.round(v * 100))}
        role="img"
        aria-label={v == null ? t.bench.noSpeechDot : t.bench.overlap(Math.round(v * 100))}
      />
      {selected && mode === 'sync' && (
        <div className="row-extra">
          <button type="button" onClick={() => onPlayLine(i)}>
            {t.bench.playLine}
          </button>
          <button type="button" onClick={onAnchor}>
            {t.bench.anchorHere}
          </button>
          <button type="button" onClick={onSplit}>
            {t.bench.splitHere}
          </button>
        </div>
      )}
      {selected && mode === 'edit' && (
        <div className="row-extra">
          <textarea
            rows={2}
            aria-label={t.bench.lineText(i + 1)}
            value={m.text}
            onFocus={onTextFocus}
            onChange={(e) => onText(i, e.target.value)}
          />
          {(
            [
              [t.bench.start, 's'],
              [t.bench.end, 'e'],
            ] as const
          ).map(([label, side]) => (
            <span className="grp" key={side}>
              {label}
              <button type="button" aria-label={`${label} ${t.bench.minus50}`} onClick={() => onEdit(i, `${side}-`)}>
                {t.bench.minus50}
              </button>
              <button type="button" aria-label={`${label} ${t.bench.plus50}`} onClick={() => onEdit(i, `${side}+`)}>
                {t.bench.plus50}
              </button>
              <button type="button" aria-label={`${label}${t.bench.setNow}`} onClick={() => onEdit(i, `${side}=`)}>
                {t.bench.setNow}
              </button>
            </span>
          ))}
          <button type="button" onClick={() => onEdit(i, 'del')}>
            {m.deleted ? t.bench.restoreLine : t.bench.deleteLine}
          </button>
          <button type="button" onClick={() => onPlayLine(i)}>
            {t.bench.playLine}
          </button>
        </div>
      )}
    </div>
  );
});
