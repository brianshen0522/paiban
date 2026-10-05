import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Candidate,
  CandidateList,
  Cue,
  DetectedLang,
  Lang,
  ProviderStatus,
  Settings,
  SpeechData,
  Subtitle,
  SyncDoc,
  UserRef,
} from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { many, one } from '../db/pool.js';
import { ASSRT_CREDIT, type FilmContext, PROVIDER_ORDER, type ProviderKey } from './providers/index.js';

/**
 * Where subtitle files live and how their rows read (docs/03-data-model.md, "字幕";
 * docs/02-architecture.md, "磁碟配置"). Paths come from ids, never from a request.
 */
export const candidateRel = (id: string) => `subtitles/candidates/${id}`;
export const subtitleRel = (id: string) => `subtitles/${id}`;
export const candidateDir = (dataDir: string, id: string) => join(dataDir, 'subtitles', 'candidates', id);
export const subtitleDir = (dataDir: string, id: string) => join(dataDir, 'subtitles', id);
/** An upload or a download waiting for the media service: files plus manifest.json. */
export const stagingDir = (dataDir: string, name: string) => join(dataDir, 'tmp', 'uploads', name);
export type StagedFile = { file: string; name: string };

export async function readCues(dataDir: string, relDir: string): Promise<Cue[]> {
  return JSON.parse(await readFile(join(dataDir, relDir, 'cues.json'), 'utf8')) as Cue[];
}

/** The film's detected speech, when the analysis produced it; null otherwise (MEDIA_NOT_READY for alignment). */
export async function speechFor(
  q: Queryable,
  dataDir: string,
  torrentId: string,
): Promise<{ mediaId: string; speech: SpeechData } | null> {
  const m = await one<{ id: string; analysis_state: string }>(
    q,
    'select id, analysis_state from media_files where torrent_id = $1',
    [torrentId],
  );
  if (m?.analysis_state !== 'ready') return null;
  try {
    const speech = JSON.parse(await readFile(join(dataDir, 'media', m.id, 'speech.json'), 'utf8')) as SpeechData;
    return { mediaId: m.id, speech };
  } catch {
    return null;
  }
}

/** What a source needs to know about the film and the version that was downloaded. */
export async function filmContext(q: Queryable, torrentId: string): Promise<FilmContext | null> {
  const r = await one<{
    imdb_code: string;
    tmdb_id: number | null;
    title: string;
    title_zh: string | null;
    year: number;
    quality: string;
    source_type: string;
    video_codec: string;
  }>(
    q,
    `select m.imdb_code, m.tmdb_id, m.title, m.title_zh, m.year, t.quality, t.source_type, t.video_codec
       from torrents t join movies m on m.id = t.movie_id where t.id = $1 and t.want <> 'remove'`,
    [torrentId],
  );
  if (!r) return null;
  return {
    imdbCode: r.imdb_code,
    tmdbId: r.tmdb_id,
    title: r.title,
    titleZh: r.title_zh,
    year: r.year,
    release: { quality: r.quality, source: r.source_type, videoCodec: r.video_codec },
  };
}

/* ---------------------------------------------------------------- matching the downloaded version */

/** docs/07, "和下載的版本相符": YIFY or YTS in the name, and the same resolution or none written. */
export function matchesRelease(name: string, quality: string): boolean {
  if (!/yify|yts/i.test(name)) return false;
  const res = name.match(/\b(720p|1080p|2160p)\b/i)?.[1]?.toLowerCase();
  return !res || res === quality.toLowerCase();
}

export function sourceKind(name: string): 'bluray' | 'web' | null {
  if (/blu-?ray|brrip|bdrip/i.test(name)) return 'bluray';
  if (/\bweb(-?dl|-?rip)?\b/i.test(name)) return 'web';
  return null;
}

/** Which detected languages a choice of languages covers: Traditional takes every Chinese (docs/07, "全部自動對齊並排名"). */
export function coveredLanguages(languages: readonly Lang[]): DetectedLang[] {
  const out = new Set<DetectedLang>();
  for (const l of languages) {
    if (l === 'en') out.add('en');
    if (l === 'zh-Hant') for (const x of ['zh-Hant', 'zh', 'zh-Hans'] as const) out.add(x);
    if (l === 'zh-Hans') for (const x of ['zh-Hans', 'zh'] as const) out.add(x);
  }
  return [...out];
}

/* ---------------------------------------------------------------- candidates */

export type CandidateRow = {
  id: string;
  torrent_id: string;
  provider: ProviderKey | 'upload';
  provider_ref: string;
  language_label: string;
  language: DetectedLang;
  release_name: string;
  uploader: string | null;
  page_url: string | null;
  download_url: string | null;
  flags: Partial<Candidate['flags']> & { rating?: number | null };
  fetch_state: Candidate['fetch'];
  fetch_error: Candidate['fetchError'];
  rel_dir: string | null;
  detected_encoding: string | null;
  cue_count: number | null;
  align_state: Candidate['align']['state'];
  align_score: number | null;
  align_result: unknown;
  created_at: Date;
  added: boolean;
};

const CANDIDATE_SELECT = `select c.*, exists (select 1 from subtitles s where s.torrent_id = c.torrent_id and s.provider = c.provider
                                               and s.provider_ref = c.provider_ref) as added
  from subtitle_candidates c`;

export async function candidateRows(q: Queryable, torrentId: string): Promise<CandidateRow[]> {
  return many<CandidateRow>(q, `${CANDIDATE_SELECT} where c.torrent_id = $1`, [torrentId]);
}

export async function candidateRow(q: Queryable, id: string): Promise<CandidateRow | null> {
  return one<CandidateRow>(q, `${CANDIDATE_SELECT} where c.id = $1`, [id]);
}

const PROVIDER_RANK: Record<string, number> = { justsubtitles: 0, yify: 1, assrt: 2, upload: 3 };

/**
 * The order before ranking (docs/07): chosen languages → matches the version → same kind of
 * source → the source's own rating → JustSubtitles, YIFY, 射手網. Uploads after the sources.
 */
export function preRankOrder(
  rows: CandidateRow[],
  languages: readonly Lang[],
  release: { quality: string; source: string },
): CandidateRow[] {
  const langRank = (l: DetectedLang) => {
    const i = languages.findIndex((x) => x === l || (l === 'zh' && x === 'zh-Hant') || (l === 'zh' && x === 'zh-Hans'));
    if (i >= 0) return i;
    const zh = languages.indexOf('zh-Hant');
    return zh >= 0 && (l === 'zh-Hans' || l === 'zh') ? zh + 0.5 : languages.length;
  };
  const key = (r: CandidateRow) => [
    langRank(r.language),
    matchesRelease(r.release_name, release.quality) ? 0 : 1,
    sourceKind(r.release_name) && sourceKind(r.release_name) === release.source ? 0 : 1,
    -(r.flags.rating ?? -1),
    PROVIDER_RANK[r.provider] ?? 9,
    r.created_at.getTime(),
  ];
  return [...rows].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    for (let i = 0; i < ka.length; i++)
      if ((ka[i] as number) !== (kb[i] as number)) return (ka[i] as number) - (kb[i] as number);
    return 0;
  });
}

/** "建議": the highest score in each language group (zh joins zh-Hant), computed when read. */
function recommendedIds(rows: CandidateRow[]): Set<string> {
  const best = new Map<string, CandidateRow>();
  for (const r of rows) {
    if (r.align_state !== 'done' || r.align_score === null) continue;
    const group = r.language === 'zh' ? 'zh-Hant' : r.language;
    const cur = best.get(group);
    if (!cur || (cur.align_score ?? 0) < r.align_score) best.set(group, r);
  }
  return new Set([...best.values()].map((r) => r.id));
}

export function toCandidate(r: CandidateRow, quality: string, recommended: boolean): Candidate {
  return {
    id: r.id,
    provider: r.provider,
    language: r.language,
    languageLabel: r.language_label,
    releaseName: r.release_name,
    uploader: r.uploader,
    pageUrl: r.page_url,
    flags: {
      matchesRelease: matchesRelease(r.release_name, quality),
      hearingImpaired: !!r.flags.hearingImpaired,
      ass: !!r.flags.ass,
      bilingual: !!r.flags.bilingual,
      archive: !!r.flags.archive,
      convertedFrom: r.flags.convertedFrom ?? null,
    },
    fetch: r.fetch_state,
    fetchError: r.fetch_error,
    align: { state: r.align_state, score: r.align_score },
    recommended,
    added: r.added,
  };
}

/** GET /api/torrents/:id/candidates (CandidateList). */
export async function candidateList(
  q: Queryable,
  torrentId: string,
  settings: Settings,
  languages: readonly Lang[],
): Promise<CandidateList> {
  const film = await filmContext(q, torrentId);
  const rows = await candidateRows(q, torrentId);
  const searches = await many<{
    provider: ProviderKey;
    state: 'running' | 'ok' | 'error';
    result_count: number;
    error_code: NonNullable<ProviderStatus['error']>['code'] | null;
    retry_at: Date | null;
  }>(q, 'select provider, state, result_count, error_code, retry_at from subtitle_searches where torrent_id = $1', [
    torrentId,
  ]);
  const providers: ProviderStatus[] = PROVIDER_ORDER.map((id) => {
    const s = searches.find((x) => x.provider === id);
    const credit = id === 'assrt' ? { ...ASSRT_CREDIT } : null;
    if (!settings.providers[id].enabled) return { id, state: 'disabled', count: 0, error: null, credit };
    if (!s) return { id, state: 'idle', count: 0, error: null, credit };
    return {
      id,
      state: s.state,
      count: s.result_count,
      error:
        s.state === 'error' && s.error_code
          ? { code: s.error_code, retryAt: s.retry_at ? s.retry_at.toISOString() : null }
          : null,
      credit,
    };
  });
  providers.push({
    id: 'zimuku',
    state: settings.providers.zimuku.enabled ? 'manual' : 'disabled',
    count: 0,
    error: null,
    credit: null,
  });
  const rank = await one<{ state: string }>(
    q,
    `select state from tasks where kind = 'rank' and torrent_id = $1 order by created_at desc limit 1`,
    [torrentId],
  );
  const recommended = recommendedIds(rows);
  const ordered = preRankOrder(rows, languages, film?.release ?? { quality: '', source: '' });
  const z = settings.providers.zimuku;
  const zimukuUrl =
    z.enabled && z.searchUrl && film
      ? z.searchUrl.replaceAll('{q}', encodeURIComponent(`${film.titleZh ?? film.title} ${film.year}`))
      : null;
  return {
    providers,
    candidates: ordered.map((r) => toCandidate(r, film?.release.quality ?? '', recommended.has(r.id))),
    ranking: !rank ? 'idle' : rank.state === 'queued' || rank.state === 'running' ? 'running' : 'done',
    zimukuUrl,
  };
}

/* ---------------------------------------------------------------- subtitles */

export type SubtitleRow = {
  id: string;
  torrent_id: string;
  provider: Subtitle['provider'];
  provider_ref: string | null;
  release_name: string;
  language: DetectedLang;
  format: Subtitle['format'];
  cue_count: number;
  converted_s2t: boolean;
  status: Subtitle['status'];
  score: number | null;
  doc: SyncDoc;
  doc_rev: number;
  rel_dir: string;
  updated_at: Date;
  added_by: UserRef | null;
  updated_by: UserRef | null;
  confirmed_by: UserRef | null;
};

const ref = (col: string) =>
  `(select json_build_object('id', u.id, 'displayName', u.display_name) from users u where u.id = s.${col})`;
const SUBTITLE_SELECT = `select s.id, s.torrent_id, s.provider, s.provider_ref, s.release_name, s.language, s.format, s.cue_count,
       s.converted_s2t, s.status, s.score, s.doc, s.doc_rev, s.rel_dir, s.updated_at,
       ${ref('added_by')} as added_by, ${ref('updated_by')} as updated_by, ${ref('confirmed_by')} as confirmed_by
  from subtitles s join torrents t on t.id = s.torrent_id and t.want <> 'remove'`;

export async function subtitleRows(q: Queryable, torrentId: string): Promise<SubtitleRow[]> {
  return many<SubtitleRow>(q, `${SUBTITLE_SELECT} where s.torrent_id = $1 order by s.added_at`, [torrentId]);
}

export async function subtitleRow(q: Queryable, id: string): Promise<SubtitleRow | null> {
  return one<SubtitleRow>(q, `${SUBTITLE_SELECT} where s.id = $1`, [id]);
}

export function toSubtitle(r: SubtitleRow): Subtitle {
  return {
    id: r.id,
    torrentId: r.torrent_id,
    provider: r.provider,
    releaseName: r.release_name,
    language: r.language,
    format: r.format,
    cueCount: r.cue_count,
    convertedToTraditional: r.converted_s2t,
    status: r.status,
    score: r.score,
    rev: r.doc_rev,
    addedBy: r.added_by,
    updatedBy: r.updated_by,
    confirmedBy: r.confirmed_by,
    updatedAt: r.updated_at.toISOString(),
  };
}
