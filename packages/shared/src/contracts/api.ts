/**
 * Paiban API contract (reference).
 *
 * This file is the exact shape of every request and response. docs/04-api.md explains the
 * behaviour behind each endpoint. In phase 1 this file moves into packages/shared (moved, not
 * copied: docs/14-plan.md); derive the zod schemas from it and use the same types on both sides.
 * When an endpoint has to change, change this file and docs/04-api.md together and record why
 * in docs/changes.md.
 *
 * Conventions
 * - JSON over HTTPS, all paths under /api, cookie session.
 * - Sizes are integer bytes, times are ISO 8601 UTC strings, durations and subtitle times are seconds.
 * - A failed request answers with ApiError and the HTTP status listed in ERROR_STATUS.
 * - The API never produces sentences for people. It sends codes and data; the web app owns the
 *   zh-TW wording. The only free text is `message` in ApiError and in Torrent.error, which is
 *   English and meant for logs. Film titles, file names, release names and version labels
 *   ("1080p BluRay x264") are data, not wording.
 */
import type { Cue, Segment, SpeechData, SyncDoc } from '../sync-core/core.js';

export type { Cue, Segment, SpeechData, SyncDoc };

export type Id = string; // uuid
export type IsoTime = string;
export type Bytes = number;

export type Role = 'admin' | 'member';

/** Languages the app searches for and labels. */
export type Lang = 'zh-Hant' | 'zh-Hans' | 'en';
/** What content detection can say: also "Chinese, script unclear" and "unknown". */
export type DetectedLang = Lang | 'zh' | 'und';

/* ------------------------------------------------------------------ errors */

export const ERROR_STATUS = {
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  ACCOUNT_DISABLED: 403,
  NOT_HOLDER: 403,
  NOT_FOUND: 404,
  INVITE_NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  LAST_ADMIN: 409,
  STORAGE_LIMIT: 409,
  TORRENT_STATE: 409,
  MEDIA_NOT_READY: 409,
  SUBTITLE_DUPLICATE: 409,
  REVISION_CONFLICT: 409,
  YTS_NOT_CONFIGURED: 409,
  INVITE_EXPIRED: 410,
  INVITE_USED: 410,
  RESET_INVALID: 410,
  UPLOAD_TOO_LARGE: 413,
  UNSUPPORTED_FILE: 415,
  VALIDATION: 422,
  WRONG_PASSWORD: 422,
  HASH_NOT_FROM_YTS: 422,
  CANDIDATE_UNAVAILABLE: 422,
  NO_CONFIRMED_SUBTITLE: 422,
  INVALID_FILENAME: 422,
  SETTING_INVALID: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  ALIGN_FAILED: 500,
  YTS_UNREACHABLE: 502,
  YTS_BAD_RESPONSE: 502,
  DISK_FULL: 507,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export type ApiError = {
  error: {
    code: ErrorCode;
    /** English, for logs. Never shown to people. */
    message: string;
    details?: ErrorDetails;
  };
};

export type ErrorDetails =
  /** VALIDATION / SETTING_INVALID: which fields failed and why (a code per field, not a sentence). */
  | { fields: Record<string, string> }
  /** STORAGE_LIMIT / DISK_FULL: what was asked for and what is left. */
  | { needBytes: Bytes; freeBytes: Bytes; shortBytes: Bytes; previewBytes: Bytes }
  /** REVISION_CONFLICT: what is stored now. */
  | { rev: number; doc: SyncDoc; updatedBy: UserRef | null }
  /** CANDIDATE_UNAVAILABLE: why the file behind a candidate cannot be used. */
  | { reason: CandidateFetchError | 'TIMEOUT' }
  /** RATE_LIMITED. */
  | { retryAfterSeconds: number };

/* ------------------------------------------------------------------ people */

export type UserRef = { id: Id; displayName: string };

export type UserPrefs = {
  /** Languages searched by default on the subtitles tab. At least one. */
  langs: Lang[];
  /** Convert Simplified subtitles to Traditional when adding them. */
  convertToTraditional: boolean;
  /** Show a second subtitle under the one being synced by default. */
  secondLine: boolean;
  /** Highlighted in the versions table; never downloads anything by itself. */
  quality: '720p' | '1080p' | '2160p';
};

export type User = { id: Id; username: string; displayName: string; role: Role; prefs: UserPrefs };

export type Me = {
  user: User;
  app: { name: string; version: string };
  limits: {
    uploadMaxBytes: Bytes;
    checkpointCount: number;
    /** The site-wide number of simultaneous downloads, for the "at most N at a time" line. */
    maxActiveDownloads: number;
  };
};

/** `os` and `browser` are plain names taken from the user agent ("Windows", "Edge"); null when unknown. */
export type Session = {
  id: Id;
  os: string | null;
  browser: string | null;
  current: boolean;
  lastSeenAt: IsoTime;
  createdAt: IsoTime;
};

/* ------------------------------------------------------------------ search */

export type SortKey = 'added' | 'rating' | 'year' | 'seeds';

/**
 * A film TMDB knows, offered while someone types (Brian, 2026-10-06): YTS only understands English
 * titles, TMDB also Chinese ones. Picking one looks up its IMDb code and that code on YTS.
 */
export type TmdbSuggestion = {
  tmdbId: number;
  /** The zh-TW title, or the original one when TMDB has no Chinese title. */
  title: string;
  originalTitle: string;
  year: number | null;
  /** Through this server (D30); null when TMDB has no poster. */
  posterUrl: string | null;
};

export type MovieSummary = {
  ytsId: number;
  imdbCode: string;
  title: string;
  /** TMDB's id for the film, once it has been looked up (a TMDB key is configured). */
  tmdbId: number | null;
  /** From TMDB when a key is configured, otherwise null. */
  titleZh: string | null;
  year: number;
  runtimeMin: number;
  /** TMDB's rating when TMDB has one with enough votes; otherwise the IMDb rating YTS gives. */
  rating: number;
  ratingSource: 'tmdb' | 'imdb';
  genres: string[];
  /** Always a path on this server; browsers never contact YTS. */
  posterUrl: string;
  qualities: string[];
  /** Whether the signed-in person already has this film: not at all, still downloading (queued, downloading, paused, failed), or finished (analysing counts as finished). */
  mine: 'none' | 'downloading' | 'ready';
};

export type MovieDetail = MovieSummary & {
  /** TMDB's zh-TW overview when it has one, otherwise YTS's English summary. */
  summary: string;
  /** The film's page on TMDB, opened in a new tab (D30); null before a TMDB lookup. */
  tmdbUrl: string | null;
  language: string | null;
  versions: Version[];
  usage: Usage;
  /** True when YTS could not be reached and this is the copy kept from an earlier visit. */
  stale: boolean;
  /** When the data was last fetched from YTS. */
  fetchedAt: IsoTime;
};

/** One torrent of a film as YTS lists it. */
export type Version = {
  infoHash: string;
  quality: string;
  /** 'bluray' | 'web' as YTS reports it. */
  source: string;
  videoCodec: string;
  bitDepth: number;
  audio: string;
  sizeBytes: Bytes;
  seeds: number;
  peers: number;
  uploadedAt: IsoTime | null;
  /** Predicted from codec and bit depth; confirmed by ffprobe after download. */
  directPlay: boolean;
  /** Space reserved for preview assets on top of the film itself; 0 when it plays directly. */
  previewBytes: Bytes;
  /** sizeBytes + previewBytes: what admission will ask for. */
  needBytes: Bytes;
  local: VersionLocal;
};

export type VersionLocal =
  | { kind: 'none'; fits: boolean; shortBytes: Bytes }
  | { kind: 'present'; torrentId: Id; status: TorrentStatus; progress: number; mine: boolean; holders: UserRef[] };

/* ------------------------------------------------------------------ downloads */

/**
 * What people see. Derived on the server from torrents.state and media_files.analysis_state:
 * a finished download is 'analyzing' while its analysis is pending or running, otherwise 'ready'
 * (also when the analysis failed or was never requested: the film is still usable, the
 * workbench just has no waveform until someone retries).
 */
export type TorrentStatus = 'queued' | 'downloading' | 'paused' | 'analyzing' | 'ready' | 'failed';

export type TorrentErrorCode =
  | 'STALLED'
  | 'METADATA_TIMEOUT'
  | 'SIZE_MISMATCH'
  | 'NO_VIDEO_FILE'
  | 'UNSAFE_PATH'
  | 'DISK_FULL'
  | 'IO_ERROR';

export type Torrent = {
  id: Id;
  infoHash: string;
  movie: { ytsId: number; title: string; titleZh: string | null; year: number; runtimeMin: number; posterUrl: string };
  version: { quality: string; source: string; videoCodec: string; bitDepth: number; audio: string };
  status: TorrentStatus;
  progress: number;
  sizeBytes: Bytes;
  downloadedBytes: Bytes;
  speedBps: number;
  peers: number;
  etaSeconds: number | null;
  /** 1-based place in the queue while queued. */
  queuePosition: number | null;
  /** `message` is English, for logs and the administrator; the page text comes from `code`. */
  error: { code: TorrentErrorCode; message: string } | null;
  /** Measured size of the download folder: the whole film once finished, the leftovers of a failed download, 0 otherwise. */
  diskBytes: Bytes;
  holders: UserRef[];
  requestedBy: UserRef | null;
  mine: boolean;
  queuedAt: IsoTime;
  completedAt: IsoTime | null;
  media: MediaStatus | null;
};

/**
 * What one download is doing right now, for its detail page (docs/11-pages.md, "下載細節"). Only
 * made while someone has that page open; refreshed every 2 seconds.
 */
export type TorrentLivePeer = {
  /** Stable while the connection lasts; says nothing about the address. */
  id: string;
  /** Partly hidden: "61.220.x.x", "2001:db8:x". */
  address: string;
  /** ISO 3166-1 alpha-2; null for a private address or one the table does not know. */
  country: string | null;
  /** On the same private network (or this machine). */
  local: boolean;
  client: string | null;
  /** Who opened the connection: them (`in`) or us (`out`). */
  direction: 'in' | 'out';
  transport: 'tcp' | 'utp' | 'http';
  downBps: number;
  upBps: number;
  /** Share of the film the peer has, 0 to 1. */
  has: number;
};

export type TorrentLive = {
  at: IsoTime;
  downBps: number;
  upBps: number;
  /** One point every 2 seconds, oldest first, at most the last 2 minutes. */
  history: { downBps: number; upBps: number }[];
  /** Null until the torrent's metadata has arrived. Bit strings are base64, most significant bit first. */
  pieces: {
    count: number;
    /** Bytes per piece (the last one may be shorter). */
    size: number;
    have: string;
    /** Being fetched right now. */
    active: string;
    /** One byte per piece: how many connected peers have it (at most 255). */
    availability: string;
  } | null;
  peers: TorrentLivePeer[];
  /**
   * Where this server is, as a country code; the map is centred on it and draws its lines to it.
   * From the address peers say they see us at (BEP 10 "yourip"), or the time zone until one has.
   */
  home: string;
  homeFrom: 'peers' | 'timezone';
};

export type AssetState = 'none' | 'pending' | 'running' | 'ready' | 'failed';

export type MediaErrorCode =
  | 'NO_AUDIO'
  | 'PROBE_FAILED'
  | 'PEAKS_FAILED'
  | 'SPEECH_FAILED'
  | 'TRANSCODE_FAILED'
  | 'PREVIEW_NO_SPACE'
  | 'ASR_FAILED';

export type MediaStatus = {
  id: Id;
  durationSeconds: number | null;
  fps: number | null;
  directPlay: boolean;
  /** 'none' when automatic analysis is off and nobody has asked for it yet. */
  analysis: AssetState;
  audio: AssetState;
  proxy: { state: AssetState; resolution: '480p' | '720p' | null; progress: number; bytes: Bytes };
  /**
   * Per asset: why the analysis failed, or why a preview asset failed or was not made. Separate
   * entries, so a later preview failure does not hide why there is no waveform. An entry is cleared
   * when that asset is requested again.
   */
  errors: Partial<Record<'analysis' | 'audio' | 'proxy' | 'asr', MediaErrorCode>>;
  /**
   * Speech recognition on a few windows of the film, for auto-align (docs/08, "語音辨識").
   * `language` is what was heard (ISO 639-1, as Whisper reports it). 'none' = switched off.
   */
  asr: { state: AssetState; language: string | null };
  /** Preview audio and video on disk plus what is still reserved for them: what removing the film frees besides the film. */
  previewBytes: Bytes;
  /** What POST /api/media/:id/proxy would reserve right now; 0 when no preview asset is missing. */
  previewNeedBytes: Bytes;
  /** In order of preference for the sync page. Empty until something is playable. */
  sources: { kind: 'original' | 'proxy' | 'audio'; url: string; mime: string }[];
};

/* ------------------------------------------------------------------ library */

/** A film's exports as they go with it (Brian, 2026-10-06): how many, and the space they hold now. */
export type FilmExports = { count: number; bytes: Bytes };

export type LibraryItem = {
  torrent: Torrent;
  subtitles: { total: number; confirmed: number; draft: number };
  exports: number;
  /** Every export of the film, whatever its state: deleted with the film when the last holder removes it. */
  filmExports: FilmExports;
  /** The step the card's main button leads to. */
  next: 'subtitles' | 'sync' | 'export' | 'exported';
};

export type Workspace = {
  item: LibraryItem;
  subtitles: Subtitle[];
  exports: Export[];
  usage: Usage;
  /** What admission will ask for when an export of this film is started. */
  exportNeedBytes: Bytes;
};

/* ------------------------------------------------------------------ subtitles */

export type ProviderId = 'justsubtitles' | 'yify' | 'assrt' | 'zimuku' | 'upload';

export type ProviderStatus = {
  id: ProviderId;
  /** 'manual' = assisted source the person downloads from themselves (zimuku). */
  state: 'disabled' | 'manual' | 'idle' | 'running' | 'ok' | 'error';
  count: number;
  error: { code: 'RATE_LIMITED' | 'UNREACHABLE' | 'BAD_RESPONSE' | 'NOT_CONFIGURED'; retryAt: IsoTime | null } | null;
  /** Attribution a source's terms require, shown next to its results: the name to credit and where it links. */
  credit: { name: string; url: string } | null;
};

/** Why the file behind a candidate could not be turned into a cue list. */
export type CandidateFetchError = 'DOWNLOAD_FAILED' | 'ARCHIVE_INVALID' | 'NO_SUBTITLE' | 'PARSE_FAILED';

export type Candidate = {
  id: Id;
  provider: ProviderId;
  /** Best guess before download; replaced by content detection once fetched. */
  language: DetectedLang;
  /** The provider's own label, shown small next to ours because it is often wrong. */
  languageLabel: string;
  /** For an upload: the name of the uploaded file (or of the file inside the archive). */
  releaseName: string;
  uploader: string | null;
  pageUrl: string | null;
  flags: {
    /** Release name matches the downloaded version (YIFY/YTS, same resolution). */
    matchesRelease: boolean;
    hearingImpaired: boolean;
    ass: boolean;
    bilingual: boolean;
    archive: boolean;
    /** Set once fetched: the original encoding when it was not UTF-8. */
    convertedFrom: string | null;
  };
  /** An upload starts at 'fetching' and ends at 'ready' or 'failed' like any other candidate. */
  fetch: 'new' | 'fetching' | 'ready' | 'failed';
  fetchError: CandidateFetchError | null;
  align: { state: 'none' | 'queued' | 'running' | 'done' | 'failed'; score: number | null };
  /** Highest score in its language after ranking. */
  recommended: boolean;
  /** Already added to this film as a subtitle. */
  added: boolean;
};

export type CandidateList = {
  providers: ProviderStatus[];
  candidates: Candidate[];
  /** From the latest ranking run of this film: none yet, in progress, or finished (single candidates may still have failed). */
  ranking: 'idle' | 'running' | 'done';
  /** Search page of the assisted source for this film, when enabled. */
  zimukuUrl: string | null;
};

export type Subtitle = {
  id: Id;
  torrentId: Id;
  provider: ProviderId;
  releaseName: string;
  language: DetectedLang;
  /** Format of the original file; .ssa is reported as 'ass'. */
  format: 'srt' | 'ass' | 'vtt';
  cueCount: number;
  convertedToTraditional: boolean;
  status: 'draft' | 'confirmed';
  /** Share of cue time over detected speech, 0 to 1; null until computed. */
  score: number | null;
  rev: number;
  addedBy: UserRef | null;
  updatedBy: UserRef | null;
  confirmedBy: UserRef | null;
  updatedAt: IsoTime;
};

export type SubtitleDetail = { subtitle: Subtitle; cues: Cue[]; doc: SyncDoc };

export type AlignResult = {
  segments: Segment[];
  scoreBefore: number;
  score: number;
  method:
    | 'ffsubsync-linear'
    | 'ffsubsync-split'
    | 'core'
    | 'asr'
    | 'asr-llm'
    | 'reference'
    | 'reference-text'
    | 'reference-llm';
  /** Two independent engines put every line within 0.15 s of each other. */
  agree: boolean;
  /**
   * What speech recognition contributed (docs/08, "語音辨識"); null when the film has none.
   * `pairs`: recognised lines matched with subtitle lines, by text (`via: 'text'`, same language)
   * or by the language model (`'llm'`). `support`: how many of them the chosen alignment agrees
   * with. `via: 'none'` with `llmError` set: the model was asked and failed.
   */
  heard: {
    language: string;
    pairs: number;
    support: number;
    via: 'text' | 'llm' | 'none';
    llmError: LlmErrorCode | null;
  } | null;
  /**
   * Aligned to another subtitle of the same film (docs/08, "依另一條字幕對齊"); null otherwise.
   * `via`: lines paired by text (same language), by the language model, or none paired and the
   * timing of the reference's lines decided (`timing`).
   */
  reference: {
    subtitleId: Id;
    pairs: number;
    support: number;
    via: 'text' | 'llm' | 'timing';
    llmError: LlmErrorCode | null;
    /**
     * Seconds the reference itself is off from the film's detected speech, when it clearly is;
     * null when it fits or there is no speech to check against. The reference is followed either way.
     */
    offBy: number | null;
  } | null;
  /** Ids of lines at the start or end that match nothing in the reference and look like credits: offered for deletion. */
  extraLines: number[];
};

/** A tiny fixed pairing question sent to the configured model (docs/13-settings.md, "測試連線"). */
export type AlignModelCheck = { ok: boolean; code: 'OK' | 'WRONG_ANSWER' | LlmErrorCode; ms: number };

export type LlmErrorCode =
  | 'NOT_CONFIGURED'
  | 'AUTH'
  | 'RATE_LIMITED'
  | 'REFUSED'
  | 'BAD_RESPONSE'
  | 'UNREACHABLE'
  | 'TIMEOUT';

/* ------------------------------------------------------------------ exports */

export type ExportErrorCode = 'SOURCE_MISSING' | 'MUX_FAILED' | 'VERIFY_FAILED' | 'DISK_FULL';

export type Export = {
  id: Id;
  torrentId: Id | null;
  movieTitle: string;
  /** "1080p BluRay x264": kept with the export because the film may be gone. */
  versionLabel: string;
  fileName: string;
  tracks: { language: DetectedLang; title: string; isDefault: boolean }[];
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  sizeBytes: Bytes;
  errorCode: ExportErrorCode | null;
  createdBy: UserRef | null;
  createdAt: IsoTime;
  completedAt: IsoTime | null;
  /** Present when done. Supports Range. */
  downloadUrl: string | null;
  canDelete: boolean;
};

/* ------------------------------------------------------------------ storage */

export type Usage = {
  limitBytes: Bytes;
  usedBytes: Bytes;
  /** max(0, limit - used). */
  freeBytes: Bytes;
  /** used > limit: nothing new can start until someone deletes something. */
  over: boolean;
  categories: {
    /** Finished films with their subtitles and analysis data. */
    movies: Bytes;
    /** Preview video and audio, including what is reserved for ones still being made. */
    previews: Bytes;
    /** Full size of every download that has not finished, plus its preview reservation. */
    reserved: Bytes;
    /** What failed downloads left on disk. */
    partial: Bytes;
    /** Exported MKV files, including ones being written. */
    exports: Bytes;
  };
};

export type StorageItemKind = 'movie' | 'reserved' | 'partial' | 'preview' | 'export';

export type StorageItem = {
  kind: StorageItemKind;
  /** The torrent's id for movie, reserved and partial; the media file's id for preview; the export's id for export. */
  id: Id;
  /** The film this item belongs to, so that a preview can be shown with its film. Null for an export whose film is gone. */
  torrentId: Id | null;
  movieTitle: string;
  /** "1080p BluRay x264"; null for an export. */
  version: string | null;
  /** Only for a preview. */
  previewResolution: '480p' | '720p' | null;
  /** Only for an export. */
  fileName: string | null;
  bytes: Bytes;
  /** For an export: the person who made it. Empty when nobody holds the item any more. */
  holders: UserRef[];
  lastUsedAt: IsoTime | null;
  /** For a movie, reserved or partial item: the film's exports, deleted with it. Null for the other kinds. */
  filmExports: FilmExports | null;
};

/** What the last "recalculate usage" run could not match: a folder with no row, or a row whose files are gone. */
export type StorageFinding = {
  id: Id;
  kind: 'orphan' | 'missing';
  root: 'torrents' | 'media' | 'subtitles' | 'candidates' | 'exports';
  /** The folder's name under that root. */
  name: string;
  bytes: Bytes;
  /** For 'missing': the row whose files are gone (a torrent, media file, subtitle, candidate or export id, by root) and what to call it. Null for an orphan. */
  refId: Id | null;
  movieTitle: string | null;
  fileName: string | null;
  foundAt: IsoTime;
};

/* ------------------------------------------------------------------ notifications and events */

export type Notification = {
  id: number;
  kind:
    | 'download.completed'
    | 'download.failed'
    | 'export.completed'
    | 'export.failed'
    | 'subtitle.confirmed'
    | 'item.deleted';
  /** Everything the client needs to write the sentence in zh-TW. */
  data: {
    movieTitle?: string;
    version?: string;
    actor?: string;
    language?: DetectedLang;
    fileName?: string;
    /** download.failed / export.failed. */
    errorCode?: TorrentErrorCode | ExportErrorCode;
    /** item.deleted: what an administrator removed. */
    itemKind?: StorageItemKind;
  };
  /** Where a click goes; null when the target no longer exists. */
  link: { page: 'downloads' | 'workspace'; torrentId?: Id; tab?: 'subtitles' | 'sync' | 'export' } | null;
  createdAt: IsoTime;
  read: boolean;
};

/**
 * Sent on GET /api/events as `data: <json>`. Clients patch their caches or refetch.
 * Analysis and preview progress travel inside `torrent` (Torrent.media). Background tasks,
 * users, settings, sources and the storage findings are announced with `admin`; the page
 * refetches. Service heartbeats are not pushed: the system page polls while it is open.
 */
export type ServerEvent =
  | { type: 'torrent'; torrent: Torrent }
  | { type: 'torrent.removed'; id: Id }
  | { type: 'candidates'; torrentId: Id }
  | { type: 'subtitle'; torrentId: Id; subtitleId: Id; rev: number; removed: boolean; by: UserRef | null }
  | { type: 'export'; export: Export }
  | { type: 'export.removed'; id: Id }
  | { type: 'usage'; usage: Usage }
  | { type: 'notification'; notification: Notification }
  | { type: 'admin'; what: 'tasks' | 'users' | 'settings' | 'sources' | 'storage' };

/* ------------------------------------------------------------------ administration */

export type AdminUser = User & {
  disabled: boolean;
  lastSeenAt: IsoTime | null;
  held: number;
  activeDownloads: number;
  soleHolderOf: number;
};

export type Invite = {
  id: Id;
  code: string;
  url: string;
  role: Role;
  state: 'open' | 'used' | 'expired';
  createdBy: UserRef | null;
  expiresAt: IsoTime;
  usedBy: UserRef | null;
};

export type SourceId = 'yts' | 'tmdb' | 'justsubtitles' | 'subdl' | 'yify' | 'assrt';

export type SourceCheckCode =
  | 'OK'
  | 'NOT_CONFIGURED'
  | 'INVALID_KEY'
  | 'UNREACHABLE'
  | 'BAD_RESPONSE'
  | 'REDIRECTED'
  | 'RATE_LIMITED';

/**
 * Result of trying a source once. `data` holds the numbers and names the sentence needs:
 * {status}, {count}, {rows}, {quota}, {host} for a redirect, {retryAfterSeconds}.
 */
export type SourceCheck = { ok: boolean; code: SourceCheckCode; data: Record<string, string | number>; ms: number };

/** The latest thing known about a source, from a test or from ordinary use. */
export type SourceHealth = {
  id: SourceId | 'zimuku';
  state: 'ok' | 'warn' | 'down' | 'manual' | 'off';
  checkedAt: IsoTime | null;
  code: SourceCheckCode | null;
  data: Record<string, string | number>;
};

export type TaskKind = 'analyze' | 'asr' | 'preview' | 'align' | 'rank' | 'export' | 'rescan';

export type Task = {
  id: Id;
  kind: TaskKind;
  /** What the job is about, as data; the client writes the label. */
  subject: { movieTitle?: string; version?: string; language?: DetectedLang; fileName?: string };
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  progress: number;
  errorCode: string | null;
  /** Whether POST /api/admin/tasks/:id/retry applies: failed analyze, preview and rescan tasks. */
  retryable: boolean;
  /** A few numbers worth showing when it is done. Rescan: {corrected, orphans, missing}. Null otherwise. */
  summary: Record<string, number> | null;
  seconds: number | null;
  createdAt: IsoTime;
};

/** `version` is the build the service reports in its heartbeat; null for postgres and for a service that never reported. */
export type ServiceStatus = {
  name: 'api' | 'torrent' | 'media' | 'postgres';
  state: 'up' | 'down';
  since: IsoTime | null;
  version: string | null;
};

/**
 * One entry per thing to deal with: FAILED_DOWNLOAD once per failed download, FAILED_TASK once
 * per analysis or preview asset that is in a failed state now, SOURCE_DOWN once per source.
 * `data` carries what the sentence needs (docs/11-pages.md lists it per code).
 */
export type ProblemCode =
  | 'OVER_LIMIT'
  | 'NEARLY_FULL'
  | 'DISK_LOW'
  | 'FAILED_DOWNLOAD'
  | 'YTS_NOT_CONFIGURED'
  | 'YTS_DOWN'
  | 'SOURCE_DOWN'
  | 'FAILED_TASK'
  | 'SERVICE_DOWN'
  | 'MISSING_FILES'
  | 'ORPHANS'
  | 'NO_HOLDERS';

export type AdminOverview = {
  usage: Usage;
  downloads: { active: number; maxActive: number; queued: number };
  users: { active: number; disabled: number; openInvites: number };
  tasks: { running: number; current: Task | null };
  problems: {
    level: 'bad' | 'warn';
    code: ProblemCode;
    data: Record<string, string | number>;
    page: 'storage' | 'downloads' | 'sources' | 'system';
  }[];
  sources: SourceHealth[];
  recent: AuditEntry[];
};

/**
 * `action` is a stable code (docs/12-auth.md). `target` is what it was done to, as data.
 * `actorName` is the name as it was at the time, so the line still reads after the account is gone.
 */
export type AuditEntry = {
  id: number;
  at: IsoTime;
  actor: UserRef | null;
  actorName: string;
  action: string;
  target: Record<string, string | number>;
};

/** The capacity limit is not here: it has its own endpoint and is reported in Usage. */
export type Settings = {
  downloads: {
    maxActive: number;
    maxPerUser: number;
    /** Kilobytes (1024 bytes) per second; 0 = unlimited. */
    downloadLimitKB: number;
    uploadLimitKB: number;
    seedMode: 'stop' | 'ratio';
    stallMinutes: number;
    trackers: string[];
  };
  media: { analyzeAuto: boolean; proxyAuto: boolean; proxyResolution: '480p' | '720p' };
  yts: { baseUrl: string };
  providers: {
    cacheHours: number;
    justsubtitles: { enabled: boolean; mode: 'direct' | 'subdl' };
    yify: { enabled: boolean; baseUrl: string };
    assrt: { enabled: boolean };
    zimuku: { enabled: boolean; searchUrl: string };
  };
  subtitles: { defaultLangs: Lang[] };
  /**
   * Auto-align with recognised speech (docs/08, "語音辨識" and "語言模型"). `asr` switches
   * recognition for newly analysed films. `llm` pairs recognised speech with a subtitle in
   * another language; its key is the `llmKey` secret.
   */
  align: {
    asr: boolean;
    llm: {
      provider: 'none' | 'anthropic' | 'openai';
      /** Empty = the provider's default (Claude Opus 5.5 for Anthropic). Required for 'openai'. */
      model: string;
      /** Only for 'openai' (any OpenAI-compatible server: Qwen on DashScope, Ollama, vLLM); may be on the local network. */
      baseUrl: string;
    };
  };
};

/** Read-only facts shown next to the settings. */
export type SettingsInfo = {
  /** Which secrets are set. Their values are write-only. */
  secrets: { tmdbKey: boolean; subdlKey: boolean; assrtToken: boolean; llmKey: boolean };
  /** From the environment; the published Docker ports have to match, so they are not editable here. */
  torrentPort: number;
  torrentDhtPort: number;
  incoming: { seen: boolean; lastAt: IsoTime | null };
  disk: DiskInfo;
};

/** The filesystem that holds /data: its size, what is free now, what the app always leaves free, and the highest limit that can be set. */
export type DiskInfo = { totalBytes: Bytes; availableBytes: Bytes; reserveBytes: Bytes; maxLimitBytes: Bytes };

export type SecretName = 'tmdbKey' | 'subdlKey' | 'assrtToken' | 'llmKey';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (infer U)[] ? U[] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};

/* ------------------------------------------------------------------ endpoints */

type None = Record<string, never>;

/**
 * Every endpoint: `query` for the query string, `body` for JSON, `ok` for the 2xx payload
 * (`null` means 204). Binary endpoints say what they send in `ok`.
 */
export interface Endpoints {
  /* health */
  'GET /api/health': { ok: { ok: true } };

  /* sign-in and account */
  'POST /api/auth/login': { body: { username: string; password: string }; ok: Me };
  'POST /api/auth/logout': { ok: null };
  'GET /api/auth/me': { ok: Me };
  'GET /api/invites/:code': { ok: { role: Role; expiresAt: IsoTime } };
  'POST /api/auth/register': {
    body: { code: string; displayName: string; username: string; password: string };
    ok: Me;
  };
  'GET /api/auth/reset/:token': { ok: { username: string } };
  'POST /api/auth/reset/:token': { body: { password: string }; ok: null };
  'PATCH /api/me': { body: { displayName?: string; prefs?: Partial<UserPrefs> }; ok: User };
  'POST /api/me/password': { body: { current: string; next: string }; ok: null };
  'GET /api/me/sessions': { ok: Session[] };
  'DELETE /api/me/sessions/:id': { ok: null };

  /* search */
  'GET /api/yts/movies': {
    query: {
      q?: string;
      quality?: '720p' | '1080p' | '2160p';
      genre?: string;
      minRating?: number;
      sort?: SortKey;
      page?: number;
    };
    ok: { items: MovieSummary[]; total: number; page: number; pageSize: number };
  };
  'GET /api/yts/movies/:ytsId': { ok: MovieDetail };
  'GET /api/yts/movies/:ytsId/poster': { ok: 'image/*' };
  /** Up to 8 films as you type; `available` is false when no TMDB key is set (nothing is asked). */
  'GET /api/tmdb/suggest': { query: { q: string }; ok: { items: TmdbSuggestion[]; available: boolean } };
  /** The film on YTS for a TMDB film, by its IMDb code; `ytsId` null when YTS does not have it. */
  'GET /api/tmdb/:tmdbId/yts': { ok: { ytsId: number | null; imdbCode: string | null } };
  'GET /api/tmdb/poster/:file': { ok: 'image/*' };

  /* downloads */
  'POST /api/torrents': { body: { ytsId: number; infoHash: string }; ok: { torrent: Torrent; joined: boolean } };
  'GET /api/torrents': { query: { scope?: 'mine' | 'all' }; ok: Torrent[] };
  /** Null while the first snapshot is being made (it arrives within 2 seconds) or when the download is not running. */
  'GET /api/torrents/:id/live': { ok: TorrentLive | null };
  'GET /api/torrents/:id': { ok: Torrent };
  'POST /api/torrents/:id/pause': { ok: Torrent };
  'POST /api/torrents/:id/resume': { ok: Torrent };
  'POST /api/torrents/:id/retry': { ok: Torrent };
  'DELETE /api/torrents/:id/hold': { ok: { deleted: boolean; freedBytes: Bytes } };

  /* library */
  'GET /api/library': { ok: LibraryItem[] };
  'GET /api/library/:torrentId': { ok: Workspace };

  /* media */
  'GET /api/media/:id': { ok: MediaStatus };
  'GET /api/media/:id/original': { ok: 'video/* with Range' };
  'GET /api/media/:id/proxy': { ok: 'video/mp4 with Range' };
  'GET /api/media/:id/audio': { ok: 'audio/mp4 with Range' };
  'GET /api/media/:id/peaks': { ok: 'application/octet-stream: Int8 (min, max) pairs, 50 per second' };
  'GET /api/media/:id/speech': { ok: SpeechData };
  'POST /api/media/:id/analyze': { ok: MediaStatus };
  'POST /api/media/:id/proxy': { ok: MediaStatus };

  /* subtitles */
  'GET /api/torrents/:id/candidates': { ok: CandidateList };
  'POST /api/torrents/:id/subtitle-search': {
    body: { languages: Lang[]; provider?: ProviderId; refresh?: boolean };
    ok: CandidateList;
  };
  'POST /api/torrents/:id/candidates/rank': { body: { languages: Lang[] }; ok: CandidateList };
  'POST /api/torrents/:id/uploads': { body: 'multipart/form-data: one field "file"'; ok: CandidateList };
  'POST /api/candidates/:id/add': { body: { convertToTraditional?: boolean }; ok: Subtitle };
  'DELETE /api/candidates/:id': { ok: null };
  'GET /api/torrents/:id/subtitles': { ok: Subtitle[] };
  'GET /api/subtitles/:id': { ok: SubtitleDetail };
  'PUT /api/subtitles/:id/doc': {
    body: { rev: number; doc: SyncDoc; reason?: 'auto-align' | 'reset' };
    ok: { rev: number; status: 'draft' | 'confirmed'; score: number | null };
  };
  /** With `referenceId`: align to that subtitle of the same film instead of to the film's sound. */
  'POST /api/subtitles/:id/auto-align': { body: { allowSplit: boolean; referenceId?: Id }; ok: AlignResult };
  'POST /api/subtitles/:id/confirm': { body: { rev: number; force?: boolean }; ok: Subtitle };
  'GET /api/subtitles/:id/file': { query: { synced?: boolean }; ok: 'application/x-subrip, attachment' };
  'DELETE /api/subtitles/:id': { ok: null };

  /* exports */
  'POST /api/torrents/:id/exports': {
    body: { fileName: string; tracks: { subtitleId: Id; isDefault: boolean }[] };
    ok: Export;
  };
  'GET /api/exports': { query: { scope?: 'mine' | 'all' }; ok: Export[] };
  'GET /api/exports/:id/file': { ok: 'video/x-matroska with Range, attachment' };
  'DELETE /api/exports/:id': { ok: { freedBytes: Bytes } };

  /* storage, notifications, live updates */
  /** `items` are the films the caller holds (movie, reserved, partial, preview). Their own exports come from GET /api/exports. */
  'GET /api/storage': { ok: { usage: Usage; items: StorageItem[] } };
  'GET /api/notifications': { ok: { items: Notification[]; unread: number } };
  'POST /api/notifications/read': { body: { ids?: number[]; all?: boolean }; ok: null };
  'GET /api/events': { ok: 'text/event-stream of ServerEvent' };

  /* administration */
  'GET /api/admin/overview': { ok: AdminOverview };
  'GET /api/admin/users': { ok: AdminUser[] };
  'PATCH /api/admin/users/:id': { body: { role?: Role; disabled?: boolean }; ok: AdminUser };
  'POST /api/admin/users/:id/reset-link': { ok: { url: string; expiresAt: IsoTime } };
  'DELETE /api/admin/users/:id': { ok: null };
  'GET /api/admin/invites': { ok: Invite[] };
  'POST /api/admin/invites': { body: { role: Role; days: 1 | 3 | 7 }; ok: Invite };
  'DELETE /api/admin/invites/:id': { ok: null };
  'GET /api/admin/storage': {
    ok: { usage: Usage; items: StorageItem[]; disk: DiskInfo; findings: StorageFinding[]; rescan: Task | null };
  };
  'PUT /api/admin/storage/limit': { body: { limitBytes: Bytes }; ok: Usage };
  'POST /api/admin/storage/rescan': { ok: Task };
  /** `:kind` is a StorageItemKind, or 'orphan' with the id of a StorageFinding. */
  'DELETE /api/admin/storage/items/:kind/:id': { ok: { freedBytes: Bytes } };
  'GET /api/admin/settings': { ok: { settings: Settings; info: SettingsInfo; sources: SourceHealth[] } };
  'PATCH /api/admin/settings': {
    body: DeepPartial<Settings>;
    ok: { settings: Settings; info: SettingsInfo; sources: SourceHealth[] };
  };
  'PUT /api/admin/secrets/:name': { body: { value: string }; ok: null };
  'DELETE /api/admin/secrets/:name': { ok: null };
  /** Always 200: a source that cannot be reached is a result, not an error of this endpoint. */
  'POST /api/admin/sources/:id/test': { ok: SourceCheck };
  /** Always 200, like the source tests: a model that does not answer is a result. */
  'POST /api/admin/align/test': { ok: AlignModelCheck };
  'GET /api/admin/system': { ok: { services: ServiceStatus[]; tasks: Task[]; disk: DiskInfo } };
  /** Answers with the task that was retried, unchanged. The new task shows up in GET /api/admin/system after the `admin` event. */
  'POST /api/admin/tasks/:id/retry': { ok: Task };
  'GET /api/admin/audit': {
    query: { userId?: Id; before?: number };
    ok: { items: AuditEntry[]; nextBefore: number | null };
  };
}

export type EndpointKey = keyof Endpoints;
export type Body<K extends EndpointKey> = Endpoints[K] extends { body: infer B } ? B : None;
export type Query<K extends EndpointKey> = Endpoints[K] extends { query: infer Q } ? Q : None;
export type Ok<K extends EndpointKey> = Endpoints[K]['ok'];
