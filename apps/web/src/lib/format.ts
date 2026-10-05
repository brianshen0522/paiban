import { t } from '../copy/zh-TW';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

/** docs/17-ui.md, "數字怎麼寫": base 1024; ≥ 1 GB one decimal (".0" dropped), else MB to the ten, under 10 MB whole MB. */
export function bytes(n: number): string {
  if (n >= GB) {
    const v = Math.round((n / GB) * 10) / 10;
    return `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} GB`;
  }
  const mb = n / MB;
  if (mb < 10) return `${Math.max(0, Math.round(mb))} MB`;
  return `${Math.round(mb / 10) * 10} MB`;
}

export const speed = (bps: number) => `${(bps / MB).toFixed(1)} MB/s`;
export const percent = (p: number) => Math.floor(Math.min(1, Math.max(0, p)) * 100);

export function eta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  if (seconds < 60) return t.time.etaUnderMinute;
  return t.time.etaMinutes(Math.round(seconds / 60));
}

export function relative(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - Date.parse(iso));
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t.time.justNow;
  if (min < 60) return t.time.minutesAgo(min);
  const h = Math.floor(min / 60);
  if (h < 24) return t.time.hoursAgo(h);
  const d = Math.floor(h / 24);
  if (d === 1) return t.time.yesterday;
  if (d < 7) return t.time.daysAgo(d);
  if (d < 14) return t.time.lastWeek;
  if (d < 31) return t.time.weeksAgo(Math.floor(d / 7));
  return new Date(iso).toLocaleDateString('zh-TW');
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-TW', { dateStyle: 'medium', timeStyle: 'short' });
}

/** info hash: first 8 + … + last 4. */
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-4)}`;

/** A stable dark hue per title for the placeholder poster (docs/17-ui.md, "佔位海報的底色"). */
export function posterColor(title: string): string {
  let h = 0;
  for (const ch of title) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return `hsl(${h} 32% 26%)`;
}

export function sourceLabel(source: string): string {
  return source === 'bluray' ? 'BluRay' : source === 'web' ? 'WEB' : source;
}

export function versionLabel(v: { quality: string; source: string; videoCodec: string }): string {
  return [v.quality, sourceLabel(v.source), v.videoCodec].filter(Boolean).join(' ');
}

export const audioLabel = (a: string) => (a ? `AAC ${a}` : '');

export function genreLabel(g: string): string {
  return t.genres[g.toLowerCase()] ?? g;
}
