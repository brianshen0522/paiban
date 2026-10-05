import {
  type DiskInfo,
  FALLBACK_RUNTIME_MIN,
  PREVIEW_BYTES_PER_SECOND,
  type Settings,
  type Usage,
} from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { one } from '../db/pool.js';
import { ApiError } from '../http/errors.js';
import type { DiskProbe } from './disk.js';

/** The five categories and the limit (docs/10-storage.md, "用量怎麼算"; the view is in the schema). */
export async function readUsage(q: Queryable): Promise<Usage> {
  const r = await one<{
    movies_bytes: number;
    previews_bytes: number;
    reserved_bytes: number;
    partial_bytes: number;
    exports_bytes: number;
    limit: number | null;
  }>(
    q,
    `select u.*, (select (value #>> '{}')::bigint from settings where key = 'storage.limitBytes') as limit from storage_usage u`,
  );
  const c = {
    movies: r?.movies_bytes ?? 0,
    previews: r?.previews_bytes ?? 0,
    reserved: r?.reserved_bytes ?? 0,
    partial: r?.partial_bytes ?? 0,
    exports: r?.exports_bytes ?? 0,
  };
  const used = c.movies + c.previews + c.reserved + c.partial + c.exports;
  const limit = r?.limit ?? 0;
  return {
    limitBytes: limit,
    usedBytes: used,
    freeBytes: Math.max(0, limit - used),
    over: used > limit,
    categories: c,
  };
}

/**
 * Bytes already promised but not yet on disk (docs/10-storage.md, "磁碟本身的空間"): unfinished
 * downloads' missing pieces, preview reservations, and exports being written.
 */
export async function pendingWrites(q: Queryable): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `select coalesce((select sum(greatest(greatest(size_bytes, coalesce(length_bytes, 0)) - downloaded_bytes, 0) + preview_reserve_bytes)
                        from torrents where state in ('queued', 'downloading', 'paused')), 0)
          + coalesce((select sum(reserve_bytes) from media_files), 0)
          + coalesce((select sum(reserved_bytes) from exports where state in ('queued', 'running')), 0) as n`,
  );
  return r?.n ?? 0;
}

export async function diskInfo(q: Queryable, disk: DiskProbe, reserveBytes: number): Promise<DiskInfo> {
  const [{ totalBytes, availableBytes }, usage, pending] = await Promise.all([disk(), readUsage(q), pendingWrites(q)]);
  return {
    totalBytes,
    availableBytes,
    reserveBytes,
    maxLimitBytes: Math.max(0, usage.usedBytes - pending + availableBytes - reserveBytes),
  };
}

/**
 * Admission, inside the caller's transaction (docs/10-storage.md, "接受與拒絕"). First the logical
 * limit through storage_admit (which takes the advisory lock, so concurrent callers take turns),
 * then the physical disk. Throws STORAGE_LIMIT or DISK_FULL with the numbers the page needs.
 */
export async function admit(
  q: Queryable,
  disk: DiskProbe,
  reserveBytes: number,
  need: { bytes: number; previewBytes: number; releaseBytes?: number; reusedOnDisk?: number },
): Promise<void> {
  const release = need.releaseBytes ?? 0;
  const r = await one<{ ok: boolean; used_bytes: number; limit_bytes: number; short_bytes: number }>(
    q,
    'select * from storage_admit($1, $2)',
    [need.bytes, release],
  );
  if (!r) throw new Error('storage_admit returned nothing');
  if (!r.ok) {
    throw new ApiError('STORAGE_LIMIT', 'over the capacity limit', {
      needBytes: need.bytes,
      freeBytes: Math.max(0, r.limit_bytes - r.used_bytes),
      shortBytes: r.short_bytes,
      previewBytes: need.previewBytes,
    });
  }
  const { availableBytes } = await disk();
  const pending = await pendingWrites(q);
  const newWrites = need.bytes - (need.reusedOnDisk ?? 0);
  const room = availableBytes - pending - reserveBytes;
  if (room < newWrites) {
    throw new ApiError('DISK_FULL', 'the disk itself has no room', {
      needBytes: need.bytes,
      freeBytes: Math.max(0, room),
      shortBytes: newWrites - room,
      previewBytes: need.previewBytes,
    });
  }
}

export type PreviewPlan = { bytes: number; proxyRes: '480p' | '720p' | null };

/** What a download reserves for preview assets, decided once at admission (D40, docs/10-storage.md). */
export function previewPlan(directPlay: boolean, runtimeMin: number, media: Settings['media']): PreviewPlan {
  if (directPlay) return { bytes: 0, proxyRes: null };
  const seconds = (runtimeMin > 0 ? runtimeMin : FALLBACK_RUNTIME_MIN) * 60;
  if (!media.proxyAuto) return { bytes: PREVIEW_BYTES_PER_SECOND.audio * seconds, proxyRes: null };
  return {
    bytes: (PREVIEW_BYTES_PER_SECOND.audio + PREVIEW_BYTES_PER_SECOND[media.proxyResolution]) * seconds,
    proxyRes: media.proxyResolution,
  };
}

/** Predicted before download; ffprobe settles it later (docs/05-yts.md). */
export function predictDirectPlay(videoCodec: string, bitDepth: number): boolean {
  return videoCodec.toLowerCase() === 'x264' && bitDepth === 8;
}

/** Writes the initial limit from STORAGE_LIMIT_GB once, when the settings table has none. */
export async function ensureInitialLimit(q: Queryable, gb: number): Promise<boolean> {
  const r = await q.query(
    `insert into settings (key, value) values ('storage.limitBytes', $1::jsonb) on conflict (key) do nothing`,
    [JSON.stringify(gb * 1024 ** 3)],
  );
  return (r.rowCount ?? 0) > 0;
}
