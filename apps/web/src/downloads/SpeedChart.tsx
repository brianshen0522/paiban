import type { TorrentLive } from '@paiban/shared';
import { t } from '../copy';
import { speed } from '../lib/format';

const W = 600;
const H = 120;

function area(values: number[], max: number): { line: string; fill: string } {
  if (values.length < 2) return { line: '', fill: '' };
  const step = W / (values.length - 1);
  const pts = values.map((v, i) => [i * step, H - 4 - (v / max) * (H - 12)] as const);
  const line = `M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join('L')}`;
  return { line, fill: `${line}L${W},${H}L0,${H}Z` };
}

/** Download and upload speed over the last two minutes. */
export function SpeedChart({ history }: { history: TorrentLive['history'] }) {
  const down = history.map((h) => h.downBps);
  const up = history.map((h) => h.upBps);
  const max = Math.max(1024, ...down, ...up);
  const d = area(down, max);
  const u = area(up, max);
  const peak = Math.max(0, ...down);
  return (
    <figure className="speed-chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t.downloadDetail.chartLabel(speed(peak))}
      >
        <defs>
          <linearGradient id="sc-down" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#38e1ff" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#38e1ff" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="sc-up" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#ffb547" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#ffb547" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="sc-grid" />
        ))}
        {d.fill && <path d={d.fill} fill="url(#sc-down)" />}
        {u.fill && <path d={u.fill} fill="url(#sc-up)" />}
        {d.line && <path d={d.line} className="sc-down" vectorEffect="non-scaling-stroke" />}
        {u.line && <path d={u.line} className="sc-up" vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption className="sub">
        <span className="sc-key sc-key-down">{t.downloadDetail.down}</span>
        <span className="sc-key sc-key-up">{t.downloadDetail.up}</span>
        <span>{t.downloadDetail.chartScale(speed(max))}</span>
      </figcaption>
    </figure>
  );
}
