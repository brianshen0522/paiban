import type { Settings, SourceCheck, SourceId } from '@paiban/shared';
import { Assrt } from './assrt.js';
import type { ProviderEnv, ProviderKey, SubtitleProvider } from './common.js';
import { JustSubtitles, testTmdb } from './justsubtitles.js';
import { Yify } from './yify.js';

export { ASSRT_CREDIT } from './assrt.js';
export * from './common.js';

/** The searchable sources in the order the page and the ranking list them (docs/07, "和下載的版本相符"). 字幕庫 is never contacted (D27). */
export const PROVIDER_ORDER: ProviderKey[] = ['justsubtitles', 'yify', 'assrt'];

export function providerFor(env: ProviderEnv, settings: Settings, key: ProviderKey): SubtitleProvider {
  if (key === 'justsubtitles') return new JustSubtitles(env, settings.providers.justsubtitles.mode);
  if (key === 'yify') return new Yify(env, settings.providers.yify.baseUrl);
  return new Assrt(env);
}

export const enabled = (settings: Settings, key: ProviderKey) => settings.providers[key].enabled;

/** Where a search's outcome is recorded in source_health: JustSubtitles in SubDL mode is the `subdl` source. */
export function healthSource(settings: Settings, key: ProviderKey): SourceId {
  return key === 'justsubtitles' && settings.providers.justsubtitles.mode === 'subdl' ? 'subdl' : key;
}

/** `POST /api/admin/sources/:id/test` for the subtitle sources and TMDB (docs/13-settings.md, "測試連線"). */
export async function testSubtitleSource(
  env: ProviderEnv,
  settings: Settings,
  id: Exclude<SourceId, 'yts'>,
): Promise<SourceCheck> {
  if (id === 'tmdb') return testTmdb(env);
  if (id === 'justsubtitles') return new JustSubtitles(env, 'direct').test();
  if (id === 'subdl') return new JustSubtitles(env, 'subdl').testSubdl();
  if (id === 'yify') return new Yify(env, settings.providers.yify.baseUrl).test();
  return new Assrt(env).test();
}
