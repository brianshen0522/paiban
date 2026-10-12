import { extname } from 'node:path';
import { FALLBACK_RUNTIME_MIN, PREVIEW_BYTES_PER_SECOND } from '@paiban/shared';
import { z } from 'zod';

/** What ffprobe says, reduced to what the app decides with (docs/08-media-pipeline.md, "Probe"). */
export type ProbeInfo = {
  durationS: number | null;
  container: string;
  videoCodec: string | null;
  pixFmt: string | null;
  width: number | null;
  height: number | null;
  fpsNum: number | null;
  fpsDen: number | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioBitRate: number | null;
};

const Stream = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  pix_fmt: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  channels: z.number().optional(),
  bit_rate: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).partial().optional(),
});
const Probe = z.object({
  streams: z.array(Stream).default([]),
  format: z.object({ format_name: z.string().optional(), duration: z.string().optional() }).default({}),
});

export function parseProbe(json: unknown): ProbeInfo {
  const p = Probe.parse(json);
  // The first real video stream: cover art is an attached picture, not the film.
  const v = p.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = p.streams.find((s) => s.codec_type === 'audio');
  const rate = (v?.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v?.r_frame_rate) ?? '';
  const [num, den] = rate.split('/').map(Number);
  const duration = Number(p.format.duration);
  return {
    durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
    container: p.format.format_name ?? '',
    videoCodec: v?.codec_name ?? null,
    pixFmt: v?.pix_fmt ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fpsNum: num && den ? num : null,
    fpsDen: num && den ? den : null,
    audioCodec: a?.codec_name ?? null,
    audioChannels: a?.channels ?? null,
    audioBitRate: a?.bit_rate ? Number(a.bit_rate) : null,
  };
}

/**
 * Whether browsers play the file as it is (docs/08-media-pipeline.md). ffprobe names MP4 and MKV/WebM
 * containers by family, so WebM is told from MKV by the file extension. One function, so that a
 * change (say, browsers that cannot play 5.1 AAC) is made in one place.
 */
export function directPlay(info: ProbeInfo, fileName: string): boolean {
  const ext = extname(fileName).toLowerCase();
  const mp4 = info.container.includes('mp4') && ext !== '.mkv';
  const webm = info.container.includes('webm') && ext === '.webm';
  if (mp4)
    return (
      info.videoCodec === 'h264' &&
      info.pixFmt === 'yuv420p' &&
      (info.audioCodec === null || info.audioCodec === 'aac' || info.audioCodec === 'mp3')
    );
  if (webm)
    return (
      ['vp8', 'vp9', 'av1'].includes(info.videoCodec ?? '') &&
      info.pixFmt === 'yuv420p' &&
      (info.audioCodec === null || info.audioCodec === 'opus' || info.audioCodec === 'vorbis')
    );
  return false;
}

/** A small AAC track is copied into audio.m4a; anything else is converted to stereo AAC 96 kbit/s. */
export function audioCanBeCopied(info: ProbeInfo): boolean {
  return (
    info.audioCodec === 'aac' &&
    (info.audioChannels ?? 99) <= 2 &&
    (info.audioBitRate ?? Number.POSITIVE_INFINITY) <= 128_000
  );
}

export const mimeOf = (container: string | null, fileName: string): string => {
  const ext = extname(fileName).toLowerCase();
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mkv') return 'video/x-matroska';
  if (container?.includes('mp4') || ext === '.mp4' || ext === '.m4v' || ext === '.mov') return 'video/mp4';
  return 'application/octet-stream';
};

export type StreamCounts = { video: number; audio: number; subtitle: number };

/** Real video streams (cover art excluded, as `-map 0:V` does), audio and subtitle streams. */
export function streamCounts(json: unknown): StreamCounts {
  const p = Probe.parse(json);
  return {
    video: p.streams.filter((s) => s.codec_type === 'video' && !s.disposition?.attached_pic).length,
    audio: p.streams.filter((s) => s.codec_type === 'audio').length,
    subtitle: p.streams.filter((s) => s.codec_type === 'subtitle').length,
  };
}

/** Reservation for each preview asset still to be made (docs/10-storage.md, "Preview reservation"). */
export function assetReserve(durationS: number | null, runtimeMin: number, asset: 'audio' | '480p' | '720p'): number {
  const seconds = durationS && durationS > 0 ? durationS : (runtimeMin > 0 ? runtimeMin : FALLBACK_RUNTIME_MIN) * 60;
  return Math.ceil(PREVIEW_BYTES_PER_SECOND[asset] * seconds);
}
