import type { AssetState, MediaStatus, Torrent, TorrentErrorCode, TorrentStatus, UserRef } from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { many } from '../db/pool.js';
import { assetReserve, mimeOf } from '../media/probe.js';

/** Raw row from TORRENT_SELECT. */
export type TorrentRow = {
  id: string;
  info_hash: string;
  quality: string;
  source_type: string;
  video_codec: string;
  bit_depth: number;
  audio_channels: string;
  size_bytes: number;
  length_bytes: number | null;
  state: 'queued' | 'downloading' | 'paused' | 'completed' | 'failed';
  want: 'run' | 'pause' | 'remove';
  progress: number;
  downloaded_bytes: number;
  download_bps: number;
  peers: number;
  error_code: string | null;
  error_message: string | null;
  disk_bytes: number;
  preview_reserve_bytes: number;
  queued_at: Date;
  completed_at: Date | null;
  requested_by: string | null;
  req_name: string | null;
  yts_id: number;
  title: string;
  title_zh: string | null;
  year: number;
  runtime_min: number;
  holders: UserRef[];
  queue_position: number | null;
  media_id: string | null;
  duration_s: number | null;
  fps_num: number | null;
  fps_den: number | null;
  direct_play: boolean | null;
  analysis_state: AssetState | null;
  audio_state: AssetState | null;
  audio_bytes: number | null;
  proxy_state: AssetState | null;
  proxy_res: '480p' | '720p' | null;
  proxy_progress: number | null;
  proxy_bytes: number | null;
  reserve_bytes: number | null;
  media_error: MediaStatus['errors'] | null;
  container: string | null;
  rel_path: string | null;
  probe_state: AssetState | null;
  has_audio: boolean | null;
};

const TORRENT_SELECT = `
select t.id, t.info_hash, t.quality, t.source_type, t.video_codec, t.bit_depth, t.audio_channels, t.size_bytes,
       t.length_bytes, t.state, t.want, t.progress, t.downloaded_bytes, t.download_bps, t.peers, t.error_code,
       t.error_message, t.disk_bytes, t.preview_reserve_bytes, t.queued_at, t.completed_at, t.requested_by,
       ru.display_name as req_name,
       m.yts_id, m.title, m.title_zh, m.year, m.runtime_min,
       coalesce((select json_agg(json_build_object('id', u.id, 'displayName', u.display_name) order by h.added_at)
                   from torrent_holders h join users u on u.id = h.user_id where h.torrent_id = t.id), '[]'::json) as holders,
       case when t.state = 'queued' and t.want = 'run'
            then (select count(*)::int from torrents o where o.state = 'queued' and o.want = 'run' and o.queued_at <= t.queued_at)
       end as queue_position,
       mf.id as media_id, mf.duration_s, mf.fps_num, mf.fps_den, mf.direct_play, mf.analysis_state, mf.audio_state,
       mf.audio_bytes, mf.proxy_state, mf.proxy_res, mf.proxy_progress, mf.proxy_bytes, mf.reserve_bytes, mf.error as media_error,
       mf.container, mf.rel_path, mf.probe_state, (mf.probe_state <> 'ready' or mf.audio_codec is not null) as has_audio
  from torrents t
  join movies m on m.id = t.movie_id
  left join users ru on ru.id = t.requested_by
  left join media_files mf on mf.torrent_id = t.id`;

/** Torrents visible to the API (never ones being removed), filtered by `where` (uses $1…). */
export async function selectTorrents(q: Queryable, where: string, params: unknown[]): Promise<TorrentRow[]> {
  return many<TorrentRow>(q, `${TORRENT_SELECT} where t.want <> 'remove' and (${where}) order by t.queued_at`, params);
}

export function statusOf(state: TorrentRow['state'], analysis: AssetState | null): TorrentStatus {
  if (state !== 'completed') return state;
  return analysis === 'pending' || analysis === 'running' ? 'analyzing' : 'ready';
}

export const posterUrl = (ytsId: number) => `/api/yts/movies/${ytsId}/poster`;

/**
 * MediaStatus (docs/09-sync-workbench.md, "播哪個檔"): sources in the order the sync page should try
 * them, and what asking for the missing preview assets would reserve now.
 */
export function mediaStatus(r: TorrentRow, proxyResolution: '480p' | '720p' = '480p'): MediaStatus | null {
  if (!r.media_id) return null;
  const fps = r.fps_num && r.fps_den ? r.fps_num / r.fps_den : null;
  const id = r.media_id;
  const sources: MediaStatus['sources'] = [];
  if (r.direct_play && r.probe_state !== 'failed')
    sources.push({ kind: 'original', url: `/api/media/${id}/original`, mime: mimeOf(r.container, r.rel_path ?? '') });
  if (r.proxy_state === 'ready') sources.push({ kind: 'proxy', url: `/api/media/${id}/proxy`, mime: 'video/mp4' });
  if (r.audio_state === 'ready') sources.push({ kind: 'audio', url: `/api/media/${id}/audio`, mime: 'audio/mp4' });
  const missingAudio = r.has_audio !== false && (r.audio_state === 'none' || r.audio_state === 'failed');
  const missingProxy = r.proxy_state === 'none' || r.proxy_state === 'failed';
  const need = r.direct_play
    ? 0
    : (missingAudio ? assetReserve(r.duration_s, r.runtime_min, 'audio') : 0) +
      (missingProxy ? assetReserve(r.duration_s, r.runtime_min, proxyResolution) : 0);
  return {
    id,
    durationSeconds: r.duration_s,
    fps,
    directPlay: !!r.direct_play,
    analysis: r.analysis_state ?? 'none',
    audio: r.audio_state ?? 'none',
    proxy: {
      state: r.proxy_state ?? 'none',
      resolution: r.proxy_res,
      progress: r.proxy_progress ?? 0,
      bytes: r.proxy_bytes ?? 0,
    },
    errors: r.media_error ?? {},
    previewBytes: (r.audio_bytes ?? 0) + (r.proxy_bytes ?? 0) + (r.reserve_bytes ?? 0),
    previewNeedBytes: need,
    sources,
  };
}

export function toTorrent(r: TorrentRow, viewerId: string): Torrent {
  const size = Math.max(r.size_bytes, r.length_bytes ?? 0);
  const downloading = r.state === 'downloading';
  return {
    id: r.id,
    infoHash: r.info_hash,
    movie: {
      ytsId: r.yts_id,
      title: r.title,
      titleZh: r.title_zh,
      year: r.year,
      runtimeMin: r.runtime_min,
      posterUrl: posterUrl(r.yts_id),
    },
    version: {
      quality: r.quality,
      source: r.source_type,
      videoCodec: r.video_codec,
      bitDepth: r.bit_depth,
      audio: r.audio_channels,
    },
    status: statusOf(r.state, r.analysis_state),
    progress: r.progress,
    sizeBytes: size,
    downloadedBytes: r.downloaded_bytes,
    speedBps: downloading ? r.download_bps : 0,
    peers: downloading ? r.peers : 0,
    etaSeconds:
      downloading && r.download_bps > 0 ? Math.round(Math.max(0, size - r.downloaded_bytes) / r.download_bps) : null,
    queuePosition: r.queue_position,
    error:
      r.state === 'failed' && r.error_code
        ? { code: r.error_code as TorrentErrorCode, message: r.error_message ?? '' }
        : null,
    diskBytes: r.state === 'completed' || r.state === 'failed' ? r.disk_bytes : 0,
    holders: r.holders,
    requestedBy: r.requested_by ? { id: r.requested_by, displayName: r.req_name ?? '' } : null,
    mine: r.holders.some((h) => h.id === viewerId),
    queuedAt: r.queued_at.toISOString(),
    completedAt: r.completed_at ? r.completed_at.toISOString() : null,
    media: mediaStatus(r),
  };
}

export const versionLabel = (r: Pick<TorrentRow, 'quality' | 'source_type' | 'video_codec'>) =>
  [r.quality, r.source_type === 'bluray' ? 'BluRay' : r.source_type === 'web' ? 'WEB' : r.source_type, r.video_codec]
    .filter(Boolean)
    .join(' ');
