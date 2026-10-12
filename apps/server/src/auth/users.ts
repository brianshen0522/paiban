import {
  APP_VERSION,
  CHECKPOINT_COUNT,
  type Me,
  POSTER_REGIONS,
  type PosterRegion,
  SITE_NAME,
  UPLOAD_MAX_BYTES,
  type User,
  type UserPrefs,
} from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { readSettings } from '../settings/settings.js';

const QUALITIES = ['720p', '1080p', '2160p'] as const;
const LANGS = ['zh-Hant', 'zh-Hans', 'en'] as const;

/** Stored prefs merged over the defaults (docs/13-settings.md, "Personal preferences"). */
export function prefsOf(stored: Record<string, unknown>, defaultLangs: UserPrefs['langs']): UserPrefs {
  const langs = Array.isArray(stored.langs)
    ? stored.langs.filter((l): l is UserPrefs['langs'][number] => LANGS.includes(l))
    : [];
  const quality = QUALITIES.find((q) => q === stored.quality) ?? '1080p';
  return {
    langs: langs.length ? langs : defaultLangs,
    convertToTraditional: typeof stored.convertToTraditional === 'boolean' ? stored.convertToTraditional : true,
    secondLine: typeof stored.secondLine === 'boolean' ? stored.secondLine : false,
    quality,
    locale: stored.locale === 'zh-TW' || stored.locale === 'en' ? stored.locale : null,
    posterRegion: POSTER_REGIONS.includes(stored.posterRegion as PosterRegion)
      ? (stored.posterRegion as PosterRegion)
      : null,
  };
}

/** A person's interface language for names the server writes on their behalf; Chinese when they have not chosen. */
export function localeOf(stored: Record<string, unknown> | null | undefined): 'zh-TW' | 'en' {
  return stored?.locale === 'en' ? 'en' : 'zh-TW';
}

export async function buildMe(
  q: Queryable,
  u: { id: string; username: string; displayName: string; role: 'admin' | 'member'; prefs: Record<string, unknown> },
): Promise<Me> {
  const settings = await readSettings(q);
  const user: User = {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    role: u.role,
    prefs: prefsOf(u.prefs, settings.subtitles.defaultLangs),
  };
  return {
    user,
    app: { name: SITE_NAME, version: APP_VERSION },
    limits: {
      uploadMaxBytes: UPLOAD_MAX_BYTES,
      checkpointCount: CHECKPOINT_COUNT,
      maxActiveDownloads: settings.downloads.maxActive,
    },
  };
}
