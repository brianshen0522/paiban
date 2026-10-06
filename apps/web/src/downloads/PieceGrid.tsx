import type { TorrentLive } from '@paiban/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../copy/zh-TW';
import { pieceSize } from '../lib/format';

type Pieces = NonNullable<TorrentLive['pieces']>;

/** At most this many cells; bigger torrents put several pieces in one cell. */
const MAX_CELLS = 2400;

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bit = (b: Uint8Array, i: number) => ((b[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;

export type Cell = { from: number; to: number; done: number; active: boolean; availability: number };

/** Pieces grouped into cells: share done, whether any is in flight, the lowest availability among the missing. */
export function cells(p: Pieces): Cell[] {
  const have = fromB64(p.have);
  const active = fromB64(p.active);
  const avail = fromB64(p.availability);
  const per = Math.max(1, Math.ceil(p.count / MAX_CELLS));
  const out: Cell[] = [];
  for (let from = 0; from < p.count; from += per) {
    const to = Math.min(p.count, from + per);
    let done = 0;
    let act = false;
    let minAvail = Number.POSITIVE_INFINITY;
    for (let i = from; i < to; i++) {
      if (bit(have, i)) done++;
      else {
        if (bit(active, i)) act = true;
        minAvail = Math.min(minAvail, avail[i] ?? 0);
      }
    }
    out.push({
      from,
      to,
      done: done / (to - from),
      active: act,
      availability: Number.isFinite(minAvail) ? minAvail : 0,
    });
  }
  return out;
}

function cssVar(el: Element, name: string, fallback: string): string {
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

/**
 * Every piece of the file as a cell (Brian, 2026-10-06): done, being fetched now (blinking), or
 * missing, shaded by how many connected peers have it (a piece nobody has is marked). Hovering
 * or tapping a cell says which pieces it is and what state they are in.
 */
export function PieceGrid({ pieces }: { pieces: Pieces }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<Cell | null>(null);
  const list = useMemo(() => cells(pieces), [pieces]);
  const stats = useMemo(() => {
    const have = fromB64(pieces.have);
    const active = fromB64(pieces.active);
    const avail = fromB64(pieces.availability);
    let done = 0;
    let inFlight = 0;
    let nobody = 0;
    for (let i = 0; i < pieces.count; i++) {
      if (bit(have, i)) done++;
      else if (bit(active, i)) inFlight++;
      else if ((avail[i] ?? 0) === 0) nobody++;
    }
    return { done, inFlight, nobody };
  }, [pieces]);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e?.contentRect.width ?? 0)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cell = list.length > 1200 ? 8 : list.length > 400 ? 11 : 15;
  const gap = cell > 10 ? 2 : 1;
  const cols = Math.max(1, Math.floor((width + gap) / (cell + gap)));
  const rows = Math.ceil(list.length / cols);
  const height = rows * (cell + gap);

  useEffect(() => {
    const c = canvas.current;
    if (!c || !width) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr;
    c.height = height * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const done = cssVar(c, '--accent-fill', '#f4b619');
    const live = '#38e1ff';
    const missing = cssVar(c, '--line-strong', '#9aa3b2');
    const none = cssVar(c, '--bad', '#d64545');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let frame = 0;
    const draw = (time: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const blink = reduce ? 1 : 0.55 + 0.45 * Math.sin(time / 180);
      list.forEach((k, i) => {
        const x = (i % cols) * (cell + gap);
        const y = Math.floor(i / cols) * (cell + gap);
        if (k.done >= 1) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = done;
        } else if (k.active) {
          ctx.globalAlpha = blink;
          ctx.fillStyle = live;
        } else if (k.availability === 0 && k.done === 0) {
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = none;
        } else {
          // more peers have it, more visible; a part-done cell shows its share in the accent
          ctx.globalAlpha = 0.18 + Math.min(0.42, k.availability * 0.07);
          ctx.fillStyle = missing;
        }
        ctx.fillRect(x, y, cell, cell);
        if (k.done > 0 && k.done < 1) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = done;
          ctx.fillRect(x, y + cell * (1 - k.done), cell, cell * k.done);
        }
      });
      ctx.globalAlpha = 1;
      if (!reduce && list.some((k) => k.active)) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [list, width, height, cols, cell, gap]);

  const pick = (clientX: number, clientY: number) => {
    const r = canvas.current?.getBoundingClientRect();
    if (!r) return;
    const col = Math.floor((clientX - r.left) / (cell + gap));
    const row = Math.floor((clientY - r.top) / (cell + gap));
    setHover(col >= 0 && col < cols ? (list[row * cols + col] ?? null) : null);
  };

  const per = pieces.count > MAX_CELLS ? Math.ceil(pieces.count / MAX_CELLS) : 1;
  return (
    <div className="piece-grid">
      <p className="sub">
        {t.downloadDetail.piecesSummary(
          pieces.count.toLocaleString('zh-TW'),
          pieceSize(pieces.size),
          stats.done.toLocaleString('zh-TW'),
          stats.inFlight.toLocaleString('zh-TW'),
          stats.nobody.toLocaleString('zh-TW'),
        )}
        {per > 1 ? ` ${t.downloadDetail.perCell(per)}` : ''}
      </p>
      <div ref={wrap} className="pg-wrap">
        <canvas
          ref={canvas}
          style={{ width: `${width}px`, height: `${height}px` }}
          role="img"
          aria-label={t.downloadDetail.gridLabel(stats.done, pieces.count)}
          onMouseMove={(e) => pick(e.clientX, e.clientY)}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => pick(e.clientX, e.clientY)}
        />
      </div>
      <div className="pg-legend">
        <span>
          <i className="pg-done" />
          {t.downloadDetail.legendDone}
        </span>
        <span>
          <i className="pg-active" />
          {t.downloadDetail.legendActive}
        </span>
        <span>
          <i className="pg-missing" />
          {t.downloadDetail.legendMissing}
        </span>
        <span>
          <i className="pg-none" />
          {t.downloadDetail.legendNobody}
        </span>
      </div>
      <p className="sub pg-hover" aria-live="polite">
        {hover
          ? t.downloadDetail.cellInfo(
              hover.from + 1,
              hover.to,
              Math.round(hover.done * 100),
              hover.active,
              hover.availability,
            )
          : ' '}
      </p>
    </div>
  );
}
