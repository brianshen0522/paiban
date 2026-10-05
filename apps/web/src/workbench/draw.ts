/**
 * Canvas drawing for the workbench timeline and overview (docs/09-sync-workbench.md, "時間軸").
 * Colours come from the theme tokens and are re-read when the theme changes. For long films only
 * what is in view is drawn, and the waveform takes the min and max of the peaks under each pixel.
 */
import type { SyncCore, SyncDoc } from '@paiban/shared';
import { t } from '../copy/zh-TW';
import { tick } from './model';

type Speech = SyncCore.Speech;
type MappedCue = SyncCore.MappedCue;

export const PEAKS_PER_SECOND = 50;

// Timeline geometry in CSS pixels (prototype values).
export const WAVE_Y = 22;
export const WAVE_H = 58;
export const SP_Y = 88;
export const SP_H = 10;
export const LANE_Y = 112;
export const LANE_H = 40;

export type Palette = {
  line: string;
  ink: string;
  ink2: string;
  ink3: string;
  panel2: string;
  wave: string;
  speech: string;
  segs: [string, string, string];
  good: string;
  warn: string;
  bad: string;
  playhead: string;
  accent: string;
  accentInk: string;
  ui: string;
  mono: string;
};

export function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    line: v('--line'),
    ink: v('--ink'),
    ink2: v('--ink-2'),
    ink3: v('--ink-3'),
    panel2: v('--panel-2'),
    wave: v('--wave'),
    speech: v('--speech'),
    segs: [v('--seg-a'), v('--seg-b'), v('--seg-c')],
    good: v('--good'),
    warn: v('--warn'),
    bad: v('--bad'),
    playhead: v('--playhead'),
    accent: v('--accent-fill'),
    accentInk: v('--accent-ink'),
    ui: getComputedStyle(document.body).fontFamily,
    mono: v('--font-mono') || 'monospace',
  };
}

export type View = { t0: number; dur: number };

export type Scene = {
  now: number;
  duration: number;
  view: View;
  doc: SyncDoc;
  /** What is drawn: the adjusted times, or the original ones while "O" is held. */
  shown: ReadonlyArray<MappedCue>;
  /** Always the adjusted cues (deleted flags, segments, text). */
  mapped: ReadonlyArray<MappedCue>;
  showOrig: boolean;
  sel: number;
  playing: number;
  cpCur: number;
  /** Overlap with speech per cue index for the shown times; null without speech data. */
  scores: Float32Array | null;
  speech: Speech | null;
  peaks: Int8Array | null;
};

/** Size the backing store for the device pixel ratio and return a context in CSS pixels. */
export function fitCanvas(c: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number } | null {
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  if (!g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, w, h };
}

function box(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export function drawTimeline(c: HTMLCanvasElement, K: Palette, s: Scene): void {
  const f = fitCanvas(c);
  if (!f) return;
  const { g, w: W, h: H } = f;
  const pps = W / s.view.dur;
  const t0 = s.view.t0;
  const t1 = t0 + s.view.dur;
  g.clearRect(0, 0, W, H);

  // ruler
  let step = 600;
  for (const st of [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]) {
    if (st * pps >= 64) {
      step = st;
      break;
    }
  }
  g.font = `11.5px ${K.mono}`;
  g.textBaseline = 'top';
  g.lineWidth = 1;
  for (let tt = Math.ceil(t0 / step) * step; tt <= t1 + 1e-6; tt += step) {
    const x = Math.round((tt - t0) * pps) + 0.5;
    g.strokeStyle = K.line;
    g.beginPath();
    g.moveTo(x, 15);
    g.lineTo(x, H);
    g.stroke();
    g.fillStyle = K.ink3;
    g.fillText(tick(tt), x + 4, 1);
  }

  // waveform: min and max of the peaks under each pixel
  if (s.peaks) {
    const p = s.peaks;
    const mid = WAVE_Y + WAVE_H / 2;
    g.fillStyle = K.wave;
    for (let x = 0; x < W; x++) {
      const a = Math.floor((t0 + x / pps) * PEAKS_PER_SECOND);
      const b = Math.max(a + 1, Math.floor((t0 + (x + 1) / pps) * PEAKS_PER_SECOND));
      let lo = 127;
      let hi = -128;
      for (let q = Math.max(0, a); q < b && q * 2 + 1 < p.length; q++) {
        const mn = p[q * 2] ?? 0;
        const mx = p[q * 2 + 1] ?? 0;
        if (mn < lo) lo = mn;
        if (mx > hi) hi = mx;
      }
      if (hi < lo) continue;
      g.fillRect(x, mid - (hi / 128) * (WAVE_H / 2), 1, Math.max(1, ((hi - lo) / 128) * (WAVE_H / 2)));
    }
  }

  // detected speech
  if (s.speech) {
    g.fillStyle = K.speech;
    for (const [a, b] of s.speech.segs) {
      if (b < t0 || a > t1) continue;
      g.fillRect((a - t0) * pps, SP_Y, Math.max(1, (b - a) * pps), SP_H);
    }
  }

  // subtitle lane
  g.fillStyle = K.panel2;
  g.fillRect(0, LANE_Y - 5, W, LANE_H + 10);
  if (!s.showOrig) {
    s.doc.segments.forEach((seg, k) => {
      if (!k) return;
      const first = s.mapped[seg.from];
      if (!first) return;
      const x = Math.round((first.start - t0) * pps) - 5.5;
      if (x < 0 || x > W) return;
      g.strokeStyle = K.ink3;
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(x, SP_Y - 4);
      g.lineTo(x, LANE_Y + LANE_H + 8);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = K.ink3;
      g.font = `11.5px ${K.ui}`;
      g.textBaseline = 'top';
      g.fillText(t.bench.segLabel(k + 1), x + 5, LANE_Y + LANE_H + 8);
    });
  }
  // Every cue is tested (a few thousand comparisons); only those in view are drawn.
  for (let i = 0; i < s.shown.length; i++) {
    const cue = s.shown[i];
    const m = s.mapped[i];
    if (!cue || !m) continue;
    if (m.deleted || cue.end < t0 || cue.start > t1) continue;
    const xa = (cue.start - t0) * pps;
    const w = Math.max(2, (cue.end - cue.start) * pps);
    const col = K.segs[m.seg % 3] ?? K.ink3;
    g.globalAlpha = i === s.playing ? 0.62 : 0.3;
    g.fillStyle = col;
    box(g, xa, LANE_Y, w, LANE_H, 4);
    g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = i === s.sel ? K.ink : col;
    g.lineWidth = i === s.sel ? 2 : 1;
    box(g, xa + 0.5, LANE_Y + 0.5, w - 1, LANE_H - 1, 4);
    g.stroke();
    g.lineWidth = 1;
    if (s.scores && (s.scores[i] ?? 1) < 0.25 && w > 6) {
      g.fillStyle = K.bad;
      g.fillRect(xa + 3, LANE_Y + LANE_H - 5, w - 6, 3);
    }
    if (w >= 18) {
      g.save();
      g.beginPath();
      g.rect(xa, LANE_Y, w - 3, LANE_H);
      g.clip();
      g.fillStyle = K.ink;
      g.font = `12px ${K.ui}`;
      g.textBaseline = 'middle';
      g.fillText(`${i + 1}${w >= 96 ? `  ${m.text.replace(/\s*\n\s*/g, ' ')}` : ''}`, xa + 6, LANE_Y + LANE_H / 2 + 1);
      g.restore();
    }
  }

  // checkpoints above their line; anchors below, at the moment they were set
  s.doc.checkpoints.forEach((cp, j) => {
    const cue = s.shown[cp.cue];
    if (!cue) return;
    const x = (cue.start - t0) * pps + 6;
    if (x < -6 || x > W + 6) return;
    g.beginPath();
    g.arc(x, LANE_Y - 11, 4.5, 0, Math.PI * 2);
    if (cp.status === 'todo') {
      g.strokeStyle = K.ink3;
      g.lineWidth = 1.5;
      g.stroke();
      g.lineWidth = 1;
    } else {
      g.fillStyle = cp.status === 'ok' ? K.good : K.bad;
      g.fill();
    }
    if (j === s.cpCur) {
      g.strokeStyle = K.accent;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, LANE_Y - 11, 7.5, 0, Math.PI * 2);
      g.stroke();
      g.lineWidth = 1;
    }
  });
  if (!s.showOrig) {
    g.fillStyle = K.accentInk;
    for (const a of s.doc.anchors) {
      const x = (a.t - t0) * pps;
      if (x < -6 || x > W + 6) continue;
      g.beginPath();
      g.moveTo(x, LANE_Y + LANE_H + 6);
      g.lineTo(x - 5, LANE_Y + LANE_H + 15);
      g.lineTo(x + 5, LANE_Y + LANE_H + 15);
      g.closePath();
      g.fill();
    }
  }

  // playhead
  const px = Math.round((s.now - t0) * pps) + 0.5;
  if (px >= 0 && px <= W) {
    g.strokeStyle = K.playhead;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(px, 14);
    g.lineTo(px, H);
    g.stroke();
    g.lineWidth = 1;
    g.fillStyle = K.playhead;
    g.beginPath();
    g.moveTo(px - 5, 8);
    g.lineTo(px + 5, 8);
    g.lineTo(px, 16);
    g.closePath();
    g.fill();
  }
}

export function drawOverview(c: HTMLCanvasElement, K: Palette, s: Scene): void {
  const f = fitCanvas(c);
  if (!f) return;
  const { g, w: W, h: H } = f;
  const dur = Math.max(1, s.duration);
  const pps = W / dur;
  g.clearRect(0, 0, W, H);
  g.fillStyle = K.panel2;
  box(g, 0, 0, W, H, 6);
  g.fill();
  g.save();
  box(g, 0, 0, W, H, 6);
  g.clip();
  if (s.speech) {
    g.globalAlpha = 0.55;
    g.fillStyle = K.speech;
    for (const [a, b] of s.speech.segs) g.fillRect(a * pps, 6, Math.max(1, (b - a) * pps), 9);
    g.globalAlpha = 1;
  }
  for (let i = 0; i < s.shown.length; i++) {
    const cue = s.shown[i];
    if (!cue || s.mapped[i]?.deleted) continue;
    const v = s.scores ? (s.scores[i] ?? 0) : null;
    g.fillStyle = v == null ? K.ink3 : v >= 0.5 ? K.good : v >= 0.25 ? K.warn : K.bad;
    g.fillRect(cue.start * pps, 20, Math.max(1, (cue.end - cue.start) * pps - 1), 12);
  }
  g.restore();
  if (s.view.dur < dur - 0.01) {
    g.strokeStyle = K.ink2;
    g.lineWidth = 1.5;
    box(g, s.view.t0 * pps + 1, 1, Math.max(4, s.view.dur * pps - 2), H - 2, 5);
    g.stroke();
    g.lineWidth = 1;
  }
  const px = Math.round(s.now * pps) + 0.5;
  g.strokeStyle = K.playhead;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(px, 0);
  g.lineTo(px, H);
  g.stroke();
  g.lineWidth = 1;
}
