import type { TorrentLivePeer } from '@paiban/shared';
import { memo, useId, useMemo } from 'react';
import { t } from '../copy/zh-TW';
import { CENTROIDS, LAND, MAP_HEIGHT, MAP_WIDTH } from './world-map';

/**
 * The peer map (Brian, 2026-10-06: "like a cyber-attack live map"). Every connected peer is a
 * glowing point in its country with an arc to this server; light runs along the arc towards us
 * while we download from that peer and away from us while we upload to it, and the arc is
 * thicker the faster it goes. Decoration only: the peer table under it says the same in words.
 */

type Placed = { peer: TorrentLivePeer; x: number; y: number };

/** A small, stable offset per peer, so peers from one country do not sit on one pixel. */
function jitter(id: string, spread: number): [number, number] {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const angle = ((h % 360) * Math.PI) / 180;
  const r = 3 + ((h >>> 9) % 100) / (100 / spread);
  return [Math.cos(angle) * r, Math.sin(angle) * r];
}

/** A curve from a to b that rises above the straight line, more for longer trips. */
function arc(ax: number, ay: number, bx: number, by: number): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const d = Math.hypot(bx - ax, by - ay);
  const lift = Math.min(160, 18 + d * 0.32);
  return `M${ax.toFixed(1)},${ay.toFixed(1)} Q${mx.toFixed(1)},${(my - lift).toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`;
}

/** Line width from speed: hairline when idle, about 4 px at a few MB/s. */
const width = (bps: number) => (bps <= 0 ? 0.8 : Math.min(4.2, 1 + Math.log10(1 + bps / 4096)));

const GRATICULE = (() => {
  let d = '';
  for (let lon = -150; lon <= 150; lon += 30) d += `M${((lon + 180) / 360) * MAP_WIDTH},0V${MAP_HEIGHT}`;
  for (let lat = 60; lat >= -30; lat -= 30) {
    const y = ((84 - lat) / 142) * MAP_HEIGHT;
    d += `M0,${y.toFixed(1)}H${MAP_WIDTH}`;
  }
  return d;
})();

/** A longitude shift on the equirectangular map, wrapping round the edges. */
const wrap = (x: number) => ((x % MAP_WIDTH) + MAP_WIDTH) % MAP_WIDTH;

export const PeerMap = memo(function PeerMap({ peers, home }: { peers: TorrentLivePeer[]; home: string }) {
  const world = useId();
  const [homeX, hy] = CENTROIDS[home] ?? CENTROIDS.TW ?? [835, 167];
  // The server's country sits in the middle (Brian, 2026-10-06); the world is turned round to put it
  // there, so every line from a peer takes the short way.
  const shift = MAP_WIDTH / 2 - homeX;
  const hx = MAP_WIDTH / 2;
  const placed = useMemo(
    () =>
      peers.flatMap((p): Placed[] => {
        if (p.local) {
          const [dx, dy] = jitter(p.id, 10);
          return [{ peer: p, x: hx + dx * 1.6 + 10, y: hy + dy * 1.6 + 10 }];
        }
        const c = p.country ? CENTROIDS[p.country] : undefined;
        if (!c) return [];
        const [dx, dy] = jitter(p.id, 8);
        return [{ peer: p, x: wrap(c[0] + shift) + dx, y: c[1] + dy }];
      }),
    [peers, hx, hy, shift],
  );
  const busiest = Math.max(1, ...peers.map((p) => p.downBps + p.upBps));

  return (
    <svg
      className="peer-map"
      viewBox={`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`}
      preserveAspectRatio="xMidYMid meet"
      overflow="hidden"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="pm-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#7ef9ff" stopOpacity="0.9" />
          <stop offset="100%" stopColor="#7ef9ff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="pm-home" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffcf52" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#ffcf52" stopOpacity="0" />
        </radialGradient>
        <filter id="pm-blur" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
      </defs>
      <rect width={MAP_WIDTH} height={MAP_HEIGHT} className="pm-sea" />
      <defs>
        <g id={world}>
          <path d={GRATICULE} className="pm-grid" />
          <path d={LAND} className="pm-land" />
        </g>
      </defs>
      {/* the world three times side by side, shifted, so the edges join wherever it is cut */}
      {[-MAP_WIDTH, 0, MAP_WIDTH].map((o) => (
        <use key={o} href={`#${world}`} x={shift + o} />
      ))}

      {placed.map(({ peer, x, y }) => {
        const strength = (peer.downBps + peer.upBps) / busiest;
        const down = peer.downBps > 0;
        const up = peer.upBps > 0;
        return (
          <g key={peer.id} className="pm-link" style={{ opacity: 0.35 + 0.65 * strength }}>
            {/* the glow under the line, then the line, then the moving light */}
            <path
              d={arc(x, y, hx, hy)}
              className="pm-arc-glow"
              strokeWidth={width(peer.downBps) + 3}
              filter="url(#pm-blur)"
            />
            <path d={arc(x, y, hx, hy)} className="pm-arc" strokeWidth={width(Math.max(peer.downBps, peer.upBps))} />
            {down && <path d={arc(x, y, hx, hy)} className="pm-flow pm-in" strokeWidth={width(peer.downBps)} />}
            {up && <path d={arc(hx, hy, x, y)} className="pm-flow pm-out" strokeWidth={width(peer.upBps)} />}
          </g>
        );
      })}

      {placed.map(({ peer, x, y }) => (
        <g key={`n-${peer.id}`} transform={`translate(${x.toFixed(1)},${y.toFixed(1)})`}>
          <circle r={9} fill="url(#pm-glow)" className={peer.downBps + peer.upBps > 0 ? 'pm-pulse' : undefined} />
          <circle r={2.4} className="pm-peer" />
          {/* a ring that spreads once when the connection first appears */}
          <circle r={3} className="pm-ping" />
        </g>
      ))}

      <g transform={`translate(${hx},${hy})`}>
        <circle r={22} fill="url(#pm-home)" className="pm-pulse" />
        <circle r={4.2} className="pm-home" />
        <circle r={8} className="pm-home-ring" />
      </g>
    </svg>
  );
});

/** Countries a peer list covers, most peers first, as "台灣 3、日本 2". */
export function countrySummary(peers: TorrentLivePeer[], names: Intl.DisplayNames): string {
  const counts = new Map<string, number>();
  for (const p of peers) {
    const k = p.local
      ? t.downloadDetail.localNetwork
      : p.country
        ? (names.of(p.country) ?? p.country)
        : t.downloadDetail.unknownPlace;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join('、');
}
