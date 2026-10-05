import type { Settings } from '@paiban/shared';
import { z } from 'zod';
import type { Queryable } from '../db/pool.js';
import { many } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import { checkSourceUrl } from '../net/address.js';

/**
 * Site settings (docs/13-settings.md). One row per leaf key in the `settings` table; anything not
 * stored yet reads as its default. The capacity limit lives in the same table under
 * `storage.limitBytes` but has its own endpoint (storage/limit.ts).
 */
export const DEFAULT_TRACKERS = ['udp://tracker.opentrackr.org:1337/announce', 'udp://open.demonii.com:1337/announce'];

export const DEFAULTS: Settings = {
  downloads: {
    maxActive: 2,
    maxPerUser: 2,
    downloadLimitKB: 0,
    uploadLimitKB: 512,
    seedMode: 'stop',
    stallMinutes: 30,
    trackers: DEFAULT_TRACKERS,
  },
  media: { analyzeAuto: true, proxyAuto: true, proxyResolution: '480p' },
  yts: { baseUrl: '' },
  providers: {
    cacheHours: 24,
    justsubtitles: { enabled: true, mode: 'direct' },
    yify: { enabled: true, baseUrl: 'https://yts-subs.com' },
    assrt: { enabled: true },
    zimuku: { enabled: true, searchUrl: '' },
  },
  subtitles: { defaultLangs: ['zh-Hant', 'en'] },
  align: { asr: true, llm: { provider: 'none', model: '', baseUrl: '' } },
};

type Leaf = string | number | boolean | string[];

/** `{a: {b: 1}}` → `[['a.b', 1]]`. Arrays are leaves. */
export function flatten(obj: object, prefix = ''): [string, Leaf][] {
  const out: [string, Leaf][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) out.push(...flatten(v as object, key));
    else out.push([key, v as Leaf]);
  }
  return out;
}

const LEAF_KEYS = new Set(flatten(DEFAULTS).map(([k]) => k));

function setPath(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split('.');
  let node = target;
  for (const p of parts.slice(0, -1)) node = node[p] as Record<string, unknown>;
  node[parts.at(-1) as string] = value;
}

export async function readSettings(q: Queryable): Promise<Settings> {
  const out = structuredClone(DEFAULTS) as unknown as Record<string, unknown>;
  const rows = await many<{ key: string; value: unknown }>(q, 'select key, value from settings');
  for (const r of rows) if (LEAF_KEYS.has(r.key)) setPath(out, r.key, r.value);
  return out as unknown as Settings;
}

const int = (min: number, max: number) => z.number().int().min(min).max(max);

/** Per-key validation. Codes, not sentences: the web app owns the wording (docs/13-settings.md). */
const RULES: Record<string, z.ZodType> = {
  'downloads.maxActive': int(1, 5),
  'downloads.maxPerUser': int(1, 5),
  'downloads.downloadLimitKB': int(0, 1_000_000),
  'downloads.uploadLimitKB': int(0, 1_000_000),
  'downloads.seedMode': z.enum(['stop', 'ratio']),
  'downloads.stallMinutes': int(5, 240),
  'downloads.trackers': z.array(z.string()).max(20),
  'media.analyzeAuto': z.boolean(),
  'media.proxyAuto': z.boolean(),
  'media.proxyResolution': z.enum(['480p', '720p']),
  'yts.baseUrl': z.string(),
  'providers.cacheHours': int(1, 168),
  'providers.justsubtitles.enabled': z.boolean(),
  'providers.justsubtitles.mode': z.enum(['direct', 'subdl']),
  'providers.yify.enabled': z.boolean(),
  'providers.yify.baseUrl': z.string(),
  'providers.assrt.enabled': z.boolean(),
  'providers.zimuku.enabled': z.boolean(),
  'providers.zimuku.searchUrl': z.string(),
  'subtitles.defaultLangs': z.array(z.enum(['zh-Hant', 'zh-Hans', 'en'])).min(1),
  'align.asr': z.boolean(),
  'align.llm.provider': z.enum(['none', 'anthropic', 'openai']),
  'align.llm.model': z.string().trim().max(200),
  'align.llm.baseUrl': z.string().trim().max(500),
};

const TRACKER = /^(udp|https?):\/\/[^\s/]+(:\d+)?(\/\S*)?$/i;

/**
 * Validates a partial update against the current settings and returns the normalized leaves to
 * write. Any invalid key rejects the whole update with SETTING_INVALID and a code per key.
 */
export async function validatePatch(
  patch: unknown,
  current: Settings,
  opts: { allowLocal: boolean; resolveHost?: (host: string) => Promise<string[]> },
): Promise<[string, Leaf][]> {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ApiError('SETTING_INVALID', 'body must be an object', { fields: { _: 'NOT_OBJECT' } });
  }
  const fields: Record<string, string> = {};
  const out: [string, Leaf][] = [];
  for (const [key, raw] of flatten(patch)) {
    const rule = RULES[key];
    if (!rule) {
      fields[key] = 'UNKNOWN';
      continue;
    }
    const parsed = rule.safeParse(raw);
    if (!parsed.success) {
      fields[key] = 'INVALID';
      continue;
    }
    let value = parsed.data as Leaf;
    if (key === 'yts.baseUrl' || key === 'providers.yify.baseUrl') {
      const v = String(value).trim().replace(/\/+$/, '');
      if (v === '' && key === 'yts.baseUrl') value = '';
      else {
        const problem = await checkSourceUrl(v, opts);
        if (problem) {
          fields[key] = problem;
          continue;
        }
        value = v;
      }
    }
    // The administrator's own model server: it may be on the local network (Ollama, vLLM), so
    // only the form is checked, not where it points (docs/13-settings.md, "對齊").
    if (key === 'align.llm.baseUrl') {
      const v = String(value).replace(/\/+$/, '');
      if (v !== '' && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(v)) {
        fields[key] = 'URL_FORMAT';
        continue;
      }
      value = v;
    }
    if (key === 'providers.zimuku.searchUrl') {
      const v = String(value).trim();
      if (v !== '' && (!/^https:\/\/[^\s]+$/.test(v) || !v.includes('{q}'))) {
        fields[key] = v.includes('{q}') ? 'URL_FORMAT' : 'NO_PLACEHOLDER';
        continue;
      }
      value = v;
    }
    if (key === 'downloads.trackers') {
      const list = (value as string[]).map((t) => t.trim()).filter(Boolean);
      const bad = list.findIndex((t) => !TRACKER.test(t));
      if (bad >= 0) {
        fields[key] = `LINE_${bad + 1}`;
        continue;
      }
      value = list;
    }
    out.push([key, value]);
  }
  // maxPerUser may not exceed maxActive, comparing the values as they will be after the update.
  const next = (k: string, fallback: number) => (out.find(([key]) => key === k)?.[1] as number | undefined) ?? fallback;
  const maxActive = next('downloads.maxActive', current.downloads.maxActive);
  const maxPerUser = next('downloads.maxPerUser', current.downloads.maxPerUser);
  if (maxPerUser > maxActive && !fields['downloads.maxPerUser'] && !fields['downloads.maxActive']) {
    fields['downloads.maxPerUser'] = 'ABOVE_MAX_ACTIVE';
  }
  // An OpenAI-compatible server has no default address or model to fall back on.
  const nextText = (k: string, fallback: string) =>
    (out.find(([key]) => key === k)?.[1] as string | undefined) ?? fallback;
  if (nextText('align.llm.provider', current.align.llm.provider) === 'openai') {
    for (const [k, v] of [
      ['align.llm.baseUrl', current.align.llm.baseUrl],
      ['align.llm.model', current.align.llm.model],
    ] as const)
      if (!nextText(k, v) && !fields[k]) fields[k] = 'REQUIRED';
  }
  if (Object.keys(fields).length > 0) throw new ApiError('SETTING_INVALID', 'invalid settings', { fields });
  return out;
}

export async function writeSettings(q: Queryable, leaves: [string, Leaf][], userId: string | null): Promise<void> {
  for (const [key, value] of leaves) {
    await q.query(
      `insert into settings (key, value, updated_by, updated_at) values ($1, $2::jsonb, $3, now())
       on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
      [key, JSON.stringify(value), userId],
    );
  }
}
