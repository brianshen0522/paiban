import { t } from '../../copy';

/** Field codes from SETTING_INVALID into the sentences of docs/13-settings.md. */
export function fieldMessage(key: string, code: string, context: { maxActive?: number } = {}): string {
  if (code === 'URL_FORMAT' && key === 'align.llm.baseUrl') return t.fields.modelUrlFormat;
  if (code === 'REQUIRED') return t.fields.required;
  if (code === 'NO_PLACEHOLDER') return t.fields.noPlaceholder;
  if (key === 'providers.cacheHours') return t.fields.range1to168;
  if (key === 'subtitles.defaultLangs') return t.fields.atLeastOneLang;
  if (code === 'URL_FORMAT' && key === 'providers.zimuku.searchUrl') return t.fields.urlFormatPlain;
  if (code === 'URL_FORMAT')
    return t.fields.urlFormat(key === 'providers.yify.baseUrl' ? 'https://yts-subs.com' : 'https://yts.example');
  if (code === 'INTERNAL') return t.fields.internal;
  if (code === 'ABOVE_MAX_ACTIVE') return t.fields.aboveMaxActive(context.maxActive ?? 0);
  const line = /^LINE_(\d+)$/.exec(code);
  if (line) return t.fields.trackerLine(Number(line[1]));
  if (key === 'downloads.maxActive' || key === 'downloads.maxPerUser') return t.fields.range15;
  if (key === 'downloads.downloadLimitKB' || key === 'downloads.uploadLimitKB') return t.fields.nonNegative;
  if (key === 'downloads.stallMinutes') return t.fields.range5to240;
  return t.common.unknownError;
}
