/**
 * Constants that are not settings (docs/13-settings.md, "不開放設定的常數"). Kept in one place so
 * that opening one up later is a small change.
 */

/**
 * The site name people see. D9: this is the only place it may appear, so renaming the site is a
 * one-line change. Technical identifiers (cookie names, headers, NOTIFY channels, package names)
 * use `paiban` directly and do not read this.
 */
export const SITE_NAME = '拍板';
/** Latin form of the site name, used where only ASCII fits: the outgoing User-Agent. */
export const SITE_NAME_ASCII = 'Paiban';
/** Reported in Me.app.version, the heartbeat and the outgoing User-Agent. */
export const APP_VERSION = '0.1.0';

export const SEARCH_PAGE_SIZE = 24;
export const CHECKPOINT_COUNT = 8;
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
/** A torrent may be this much larger than YTS listed before admission is asked again. */
export const SIZE_SLACK_BYTES = 64 * 1024 * 1024;
export const SESSION_DAYS = 30;

/** Top-bar usage meter turns yellow, then red, below these amounts of free space. */
export const USAGE_WARN_FREE_BYTES = 2 * 1024 ** 3;
export const USAGE_BAD_FREE_BYTES = 0.5 * 1024 ** 3;

/** Preview reservation per second of film (docs/10-storage.md): bit-rate cap × 1.02 container overhead. */
export const PREVIEW_BYTES_PER_SECOND = {
  audio: 16_320,
  '480p': 88_740,
  '720p': 203_490,
} as const;
/** Used when YTS reports a runtime of 0. */
export const FALLBACK_RUNTIME_MIN = 120;
