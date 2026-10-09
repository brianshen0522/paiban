import { mkdir, readdir, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Logger } from 'pino';
import { z } from 'zod';
import { pickWindows } from '../asr/text.js';
import type { Config } from '../config.js';
import { many, one, type Pool, tx } from '../db/pool.js';
import { readSettings } from '../settings/settings.js';
import type { DiskProbe } from '../storage/disk.js';
import { folderBytes } from '../storage/measure.js';
import { removeOwnMediaOutput, removeWorkDir } from '../storage/remove.js';
import { admit } from '../storage/usage.js';
import { addBundledSubtitles } from './bundled-subs.js';
import { assetReserve, audioCanBeCopied, directPlay, type ProbeInfo, parseProbe } from './probe.js';
import { Cancelled, run, watched } from './proc.js';

/**
 * The media service's jobs (docs/08-media-pipeline.md). Every job follows the same rules: claim
 * the row with a conditional update, check every two seconds that it is still wanted, write files
 * in its own work folder or as .part, and finish with a conditional update; when that update finds
 * nothing (deleted or cancelled meanwhile) it removes what it just wrote.
 */
export type JobDeps = { pool: Pool; config: Config; log: Logger; disk: DiskProbe };

export type MediaRow = {
  id: string;
  torrent_id: string;
  info_hash: string;
  rel_path: string;
  runtime_min: number;
  probe_state: string;
  analysis_state: string;
  audio_state: string;
  proxy_state: string;
  proxy_res: '480p' | '720p' | null;
  duration_s: number | null;
  audio_codec: string | null;
  direct_play: boolean;
  probe: ProbeInfo | null;
};

export const MEDIA_ROW = `select mf.id, mf.torrent_id, t.info_hash, mf.rel_path, m.runtime_min, mf.probe_state, mf.analysis_state, mf.audio_state,
       mf.proxy_state, mf.proxy_res, mf.duration_s, mf.audio_codec, mf.direct_play, mf.probe
  from media_files mf join torrents t on t.id = mf.torrent_id join movies m on m.id = t.movie_id`;

const NPZ_TO_JSON = fileURLToPath(new URL('../../media-scripts/npz_to_speech_json.py', import.meta.url));
const ASR_SCRIPT = fileURLToPath(new URL('../../media-scripts/asr.py', import.meta.url));

export const source = (c: Config, r: Pick<MediaRow, 'info_hash' | 'rel_path'>) =>
  join(c.dataDir, 'torrents', r.info_hash, r.rel_path);
export const mediaDir = (c: Config, id: string) => join(c.dataDir, 'media', id);
const workDir = (c: Config, name: string) => join(c.dataDir, 'tmp', 'work', name);

/** Asks the api to push the film's new state, and the usage when bytes moved. */
async function notify(pool: Pool, torrentId: string, usage = false): Promise<void> {
  await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'torrent', id: torrentId })]);
  if (usage) await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
}

async function stillRunning(pool: Pool, id: string, column: string): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    pool,
    `select (mf.${column} = 'running' and t.want <> 'remove') as ok from media_files mf join torrents t on t.id = mf.torrent_id where mf.id = $1`,
    [id],
  );
  return !!r?.ok;
}

/* ================================================================ analysis: probe, peaks, speech */

export async function probeJob(d: JobDeps, row: MediaRow): Promise<void> {
  const { pool, config } = d;
  const claimed = await pool.query(
    `update media_files mf set probe_state = 'running', updated_at = now() from torrents t
      where mf.id = $1 and mf.probe_state = 'pending' and t.id = mf.torrent_id and t.want <> 'remove'`,
    [row.id],
  );
  if (!claimed.rowCount) return;
  const src = source(config, row);
  const res = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', src]).done;
  let info: ProbeInfo | null = null;
  let json: unknown = null;
  if (res.code === 0) {
    try {
      json = JSON.parse(res.stdout);
      info = parseProbe(json);
    } catch {
      info = null;
    }
  }
  if (!info?.videoCodec) {
    // Unreadable: the file is probably broken. Not retried automatically (docs/08, "特殊情況").
    await pool.query(
      `update media_files set probe_state = 'failed', error = coalesce(error, '{}'::jsonb) || '{"analysis": "PROBE_FAILED"}'::jsonb,
              analysis_state = case when analysis_state in ('pending', 'running') then 'failed' else analysis_state end,
              audio_state = case when audio_state in ('pending', 'failed') then 'none' else audio_state end,
              proxy_state = case when proxy_state in ('pending', 'failed') then 'none' else proxy_state end,
              reserve_bytes = 0, updated_at = now()
        where id = $1 and probe_state = 'running'`,
      [row.id],
    );
    d.log.warn({ media: row.id, stderr: res.stderr.slice(0, 300) }, 'ffprobe could not read the file');
    return notify(pool, row.torrent_id, true);
  }
  const dir = mediaDir(config, row.id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'probe.json'), JSON.stringify(json));
  const settings = await readSettings(pool);
  const direct = directPlay(info, row.rel_path);
  const done = await tx(pool, async (c) => {
    const cur = await one<{
      audio_state: string;
      proxy_state: string;
      proxy_res: '480p' | '720p' | null;
      direct_play: boolean;
      reserve_bytes: number;
    }>(
      c,
      `select audio_state, proxy_state, proxy_res, direct_play, reserve_bytes from media_files where id = $1 and probe_state = 'running' for update`,
      [row.id],
    );
    if (!cur) return false;
    let audio = cur.audio_state;
    let proxy = cur.proxy_state;
    let res = cur.proxy_res;
    const errors: Record<string, string> = {};
    if (direct) {
      // Predicted unplayable, plays after all: no preview assets, nothing reserved.
      if (audio === 'pending') audio = 'none';
      if (proxy === 'pending') proxy = 'none';
    } else if (cur.direct_play && audio === 'none' && proxy === 'none') {
      // Predicted playable, is not: plan now with the current settings, if the space allows.
      res = settings.media.proxyAuto ? settings.media.proxyResolution : null;
      audio = 'pending';
      proxy = res ? 'pending' : 'none';
    }
    // Otherwise the plan frozen at admission stands (D40); its reservation is re-checked below
    // against the real length.
    if (!info.audioCodec) audio = 'none';
    const want =
      (audio === 'pending' ? assetReserve(info.durationS, row.runtime_min, 'audio') : 0) +
      (proxy === 'pending' && res ? assetReserve(info.durationS, row.runtime_min, res) : 0);
    const extra = want - cur.reserve_bytes;
    if (extra > 0) {
      try {
        await admit(c, d.disk, config.storageReserveBytes, { bytes: extra, previewBytes: extra });
      } catch {
        // Not enough room: give up the preview video, keep the small audio file (docs/08, "探測").
        proxy = 'none';
        errors.proxy = 'PREVIEW_NO_SPACE';
      }
    }
    const reserve =
      (audio === 'pending' ? assetReserve(info.durationS, row.runtime_min, 'audio') : 0) +
      (proxy === 'pending' && res ? assetReserve(info.durationS, row.runtime_min, res) : 0);
    if (!info.audioCodec) errors.analysis = 'NO_AUDIO';
    await c.query(
      `update media_files set probe_state = 'ready', probe = $2, duration_s = $3, container = $4, video_codec = $5, pix_fmt = $6, width = $7, height = $8,
              fps_num = $9, fps_den = $10, audio_codec = $11, audio_channels = $12, direct_play = $13, audio_state = $14, proxy_state = $15,
              proxy_res = $16, reserve_bytes = $17, error = coalesce(error, '{}'::jsonb) || $18::jsonb,
              analysis_state = case when $19 and analysis_state <> 'ready' then 'failed' else analysis_state end, updated_at = now()
        where id = $1 and probe_state = 'running'`,
      [
        row.id,
        info,
        info.durationS,
        info.container,
        info.videoCodec,
        info.pixFmt,
        info.width,
        info.height,
        info.fpsNum,
        info.fpsDen,
        info.audioCodec,
        info.audioChannels,
        direct,
        audio,
        proxy,
        proxy === 'pending' ? res : cur.proxy_res,
        reserve,
        errors,
        !info.audioCodec,
      ],
    );
    return true;
  });
  if (!done) return;
  await notify(pool, row.torrent_id, true);
  await pool.query(`select pg_notify('paiban_media', '{}')`);
  // The subtitles the download came with (Brian, 2026-10-09). Never fails the probe.
  try {
    await addBundledSubtitles(d, row, src, json);
  } catch (err) {
    d.log.warn({ err, media: row.id }, 'could not add the subtitles that came with the download');
  }
}

/** Waveform and speech (docs/08, "波形", "人聲偵測", "給瀏覽器的人聲資料"). */
export async function analysisJob(
  d: JobDeps,
  row: MediaRow,
  taskId: string | null,
): Promise<'done' | 'failed' | 'retry' | 'skipped'> {
  const { pool, config } = d;
  const claimed = await pool.query(
    `update media_files mf set analysis_state = 'running', updated_at = now() from torrents t
      where mf.id = $1 and mf.analysis_state = 'pending' and mf.probe_state = 'ready' and t.id = mf.torrent_id and t.want <> 'remove'`,
    [row.id],
  );
  if (!claimed.rowCount) return 'skipped';
  if (taskId)
    await pool.query(`update tasks set state = 'running', started_at = coalesce(started_at, now()) where id = $1`, [
      taskId,
    ]);
  await notify(pool, row.torrent_id);
  const work = workDir(config, `analyze-${row.id}`);
  const out = mediaDir(config, row.id);
  const src = source(config, row);
  let failedPart: 'PEAKS_FAILED' | 'SPEECH_FAILED' | null = null;
  try {
    await mkdir(work, { recursive: true });
    await mkdir(out, { recursive: true });
    const wanted = () => stillRunning(pool, row.id, 'analysis_state');

    // Peaks: 8 kHz mono PCM from ffmpeg's stdout, one (min, max) pair per 20 ms (reference/pipeline/peaks.mjs).
    try {
      let child: import('node:child_process').ChildProcess | undefined;
      const peaks = await watched(
        () =>
          peaksOf(src, (c) => {
            child = c;
          }),
        wanted,
        () => child?.kill('SIGKILL'),
      );
      await writeFile(join(work, 'peaks.bin'), peaks);
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      failedPart = 'PEAKS_FAILED';
    }

    // Speech: ffsubsync on a symlink in the work folder, so its cache lands there (docs/08, "人聲偵測").
    if (!failedPart) {
      const link = join(work, `ref${extname(src)}`);
      await symlink(src, link).catch(() => undefined);
      const ffs = run(process.env.FFSUBSYNC ?? 'ffsubsync', [link, '--serialize-speech', '--vad', 'webrtc'], {
        nice: true,
      });
      const r = await watched(
        () => ffs.done,
        wanted,
        () => ffs.child.kill('SIGKILL'),
      );
      const npz = join(work, 'ref.npz');
      const conv =
        r.code === 0
          ? await run(process.env.FFS_PYTHON ?? 'python3', [NPZ_TO_JSON, npz, join(work, 'speech.json')]).done
          : null;
      if (r.code !== 0 || conv?.code !== 0) failedPart = 'SPEECH_FAILED';
    }
    if (failedPart) throw new Error(failedPart);

    // Move the results in only if the row is still ours (checked again right before writing).
    if (!(await wanted())) throw new Cancelled();
    const files = ['peaks.bin', 'ref.npz', 'speech.json'];
    for (const f of files) await rename(join(work, f), join(out, f));
    let bytes = 0;
    for (const f of [...files, 'probe.json']) bytes += (await stat(join(out, f)).catch(() => ({ size: 0 }))).size;
    // Recognition follows when it is switched on and there is something to hear (docs/08, "語音辨識").
    const asr = (await readSettings(pool)).align.asr && !!row.audio_codec;
    const fin = await pool.query(
      `update media_files mf set analysis_state = 'ready', analysis_bytes = $2, error = mf.error - 'analysis',
              asr_state = case when $3 then 'pending' else mf.asr_state end, updated_at = now() from torrents t
        where mf.id = $1 and mf.analysis_state = 'running' and t.id = mf.torrent_id and t.want <> 'remove'`,
      [row.id, bytes, asr],
    );
    if (!fin.rowCount) {
      await removeOwnMediaOutput(config.dataDir, row.id, files);
      return 'skipped';
    }
    if (taskId)
      await pool.query(`update tasks set state = 'done', progress = 1, finished_at = now() where id = $1`, [taskId]);
    await notify(pool, row.torrent_id, true);
    return 'done';
  } catch (err) {
    if (err instanceof Cancelled) {
      if (taskId)
        await pool.query(
          `update tasks set state = 'cancelled', finished_at = now() where id = $1 and state in ('queued', 'running')`,
          [taskId],
        );
      return 'skipped';
    }
    const code = failedPart ?? 'SPEECH_FAILED';
    return failAttempt(d, row, taskId, 'analysis', code);
  } finally {
    await removeWorkDir(config.dataDir, work);
  }
}

const AsrOutput = z.object({
  language: z.string().max(16),
  model: z.string(),
  windows: z.array(z.tuple([z.number(), z.number()])),
  segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
});

/**
 * Speech recognition (docs/08, "語音辨識"): Whisper on a few evenly spread windows of the film,
 * never the whole film. The result, asr.json, is what auto-align pairs subtitle lines with. A
 * failure only means auto-align works without it; it is not retried by itself.
 */
export async function asrJob(
  d: JobDeps,
  row: MediaRow,
  taskId: string | null = null,
): Promise<'done' | 'failed' | 'skipped'> {
  const { pool, config, log } = d;
  if (!(await readSettings(pool)).align.asr) {
    await pool.query(`update media_files set asr_state = 'none' where id = $1 and asr_state = 'pending'`, [row.id]);
    if (taskId)
      await pool.query(`update tasks set state = 'cancelled', finished_at = now() where id = $1 and state = 'queued'`, [
        taskId,
      ]);
    await notify(pool, row.torrent_id);
    return 'skipped';
  }
  const claimed = await pool.query(
    `update media_files mf set asr_state = 'running', updated_at = now() from torrents t
      where mf.id = $1 and mf.asr_state = 'pending' and mf.analysis_state = 'ready' and t.id = mf.torrent_id and t.want <> 'remove'`,
    [row.id],
  );
  if (!claimed.rowCount) return 'skipped';
  if (taskId)
    await pool.query(`update tasks set state = 'running', started_at = coalesce(started_at, now()) where id = $1`, [
      taskId,
    ]);
  await pool.query(`select pg_notify('paiban_events', '{"type":"task"}')`);
  await notify(pool, row.torrent_id);
  const work = workDir(config, `asr-${row.id}`);
  try {
    const python = process.env.ASR_PYTHON;
    if (!python) throw new Error('ASR_PYTHON is not set: speech recognition is not installed here');
    await mkdir(work, { recursive: true });
    const windows = pickWindows(row.duration_s ?? row.runtime_min * 60);
    const args = [ASR_SCRIPT, source(config, row), JSON.stringify(windows), '--model', process.env.ASR_MODEL ?? 'base'];
    args.push('--threads', String(cpus().length));
    if (process.env.ASR_MODELS) args.push('--models-dir', process.env.ASR_MODELS);
    const p = run(python, args, { nice: true });
    const r = await watched(
      () => p.done,
      () => stillRunning(pool, row.id, 'asr_state'),
      () => p.child.kill('SIGKILL'),
    );
    if (r.code !== 0) throw new Error(`asr.py exited with ${r.code}: ${r.stderr.slice(-300)}`);
    const transcript = AsrOutput.parse(JSON.parse(r.stdout));
    const body = JSON.stringify(transcript);
    await writeFile(join(work, 'asr.json'), body);
    if (!(await stillRunning(pool, row.id, 'asr_state'))) throw new Cancelled();
    await mkdir(mediaDir(config, row.id), { recursive: true });
    await rename(join(work, 'asr.json'), join(mediaDir(config, row.id), 'asr.json'));
    const fin = await pool.query(
      `update media_files mf set asr_state = 'ready', asr_language = $2, analysis_bytes = mf.analysis_bytes + $3,
              error = mf.error - 'asr', updated_at = now() from torrents t
        where mf.id = $1 and mf.asr_state = 'running' and t.id = mf.torrent_id and t.want <> 'remove'`,
      [row.id, transcript.language, Buffer.byteLength(body)],
    );
    if (!fin.rowCount) {
      await removeOwnMediaOutput(config.dataDir, row.id, ['asr.json']);
      return 'skipped';
    }
    log.info(
      { mediaId: row.id, language: transcript.language, lines: transcript.segments.length },
      'speech recognised',
    );
    if (taskId)
      await pool.query(`update tasks set state = 'done', progress = 1, finished_at = now() where id = $1`, [taskId]);
    await pool.query(`select pg_notify('paiban_events', '{"type":"task"}')`);
    await notify(pool, row.torrent_id, true);
    return 'done';
  } catch (err) {
    if (err instanceof Cancelled) {
      if (taskId)
        await pool.query(
          `update tasks set state = 'cancelled', finished_at = now() where id = $1 and state in ('queued', 'running')`,
          [taskId],
        );
      return 'skipped';
    }
    log.warn({ err, mediaId: row.id }, 'speech recognition failed');
    if (taskId)
      await pool.query(
        `update tasks set state = 'failed', error_code = 'ASR_FAILED', finished_at = now() where id = $1 and state = 'running'`,
        [taskId],
      );
    await pool.query(`select pg_notify('paiban_events', '{"type":"task"}')`);
    await pool.query(
      `update media_files set asr_state = 'failed', error = coalesce(error, '{}'::jsonb) || '{"asr": "ASR_FAILED"}'::jsonb, updated_at = now()
        where id = $1 and asr_state = 'running'`,
      [row.id],
    );
    await notify(pool, row.torrent_id);
    return 'failed';
  } finally {
    await removeWorkDir(config.dataDir, work);
  }
}

async function peaksOf(src: string, onChild: (c: import('node:child_process').ChildProcess) => void): Promise<Buffer> {
  const p = run(
    'ffmpeg',
    ['-v', 'error', '-nostdin', '-i', src, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'],
    { stdout: 'pipe', nice: true },
  );
  onChild(p.child);
  const window = 8000 / 50;
  const out: number[] = [];
  let lo = 127;
  let hi = -128;
  let n = 0;
  let carry: Buffer | null = null;
  for await (const raw of p.child.stdout as AsyncIterable<Buffer>) {
    let chunk: Buffer = carry ? Buffer.concat([carry, raw]) : raw;
    carry = null;
    if (chunk.length % 2) {
      carry = chunk.subarray(chunk.length - 1);
      chunk = chunk.subarray(0, chunk.length - 1);
    }
    for (let i = 0; i < chunk.length; i += 2) {
      const v = chunk.readInt16LE(i) >> 8; // keep the top 8 bits
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      if (++n === window) {
        out.push(lo, hi);
        lo = 127;
        hi = -128;
        n = 0;
      }
    }
  }
  const r = await p.done;
  if (r.code !== 0) throw new Error(`ffmpeg peaks failed: ${r.stderr.slice(0, 200)}`);
  return Buffer.from(Int8Array.from(out).buffer);
}

/* ================================================================ preview assets */

export async function previewJob(
  d: JobDeps,
  row: MediaRow,
  taskId: string | null,
): Promise<'done' | 'failed' | 'retry' | 'skipped'> {
  const { pool } = d;
  if (taskId)
    await pool.query(`update tasks set state = 'running', started_at = coalesce(started_at, now()) where id = $1`, [
      taskId,
    ]);
  for (const asset of ['audio', 'proxy'] as const) {
    const fresh = await one<MediaRow>(pool, `${MEDIA_ROW} where mf.id = $1`, [row.id]);
    if (fresh?.[`${asset}_state`] !== 'pending') continue;
    const result = await assetJob(d, fresh, asset, taskId);
    if (result !== 'done') return result;
  }
  if (taskId)
    await pool.query(
      `update tasks set state = 'done', progress = 1, finished_at = now() where id = $1 and state = 'running'`,
      [taskId],
    );
  return 'done';
}

async function assetJob(
  d: JobDeps,
  row: MediaRow,
  asset: 'audio' | 'proxy',
  taskId: string | null,
): Promise<'done' | 'failed' | 'retry' | 'skipped'> {
  const { pool, config } = d;
  const col = `${asset}_state`;
  const claimed = await pool.query(
    `update media_files mf set ${col} = 'running', updated_at = now() from torrents t
      where mf.id = $1 and mf.${col} = 'pending' and mf.probe_state = 'ready' and t.id = mf.torrent_id and t.want <> 'remove'`,
    [row.id],
  );
  if (!claimed.rowCount) return 'skipped';
  await notify(pool, row.torrent_id);
  const out = mediaDir(config, row.id);
  await mkdir(out, { recursive: true });
  const name = asset === 'audio' ? 'audio.m4a' : 'proxy.mp4';
  const part = join(out, `${name}.part`);
  const src = source(config, row);
  const info = row.probe;
  const height = row.proxy_res === '720p' ? 720 : 480;
  const args =
    asset === 'audio'
      ? info && audioCanBeCopied(info)
        ? [
            '-v',
            'error',
            '-nostdin',
            '-y',
            '-i',
            src,
            '-map',
            '0:a:0',
            '-vn',
            '-c:a',
            'copy',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            part,
          ]
        : [
            '-v',
            'error',
            '-nostdin',
            '-y',
            '-i',
            src,
            '-map',
            '0:a:0',
            '-vn',
            '-ac',
            '2',
            '-c:a',
            'aac',
            '-b:a',
            '96k',
            '-movflags',
            '+faststart',
            '-f',
            'mp4',
            part,
          ]
      : [
          '-v',
          'error',
          '-nostdin',
          '-y',
          '-progress',
          'pipe:1',
          '-nostats',
          '-i',
          src,
          '-map',
          '0:V:0',
          '-map',
          '0:a:0?',
          '-vf',
          `scale=-2:'min(${height},ih)':flags=bicubic,format=yuv420p`,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '28',
          '-maxrate',
          height === 720 ? '1500k' : '600k',
          '-bufsize',
          height === 720 ? '3000k' : '1200k',
          '-fps_mode',
          'passthrough',
          '-c:a',
          'aac',
          '-ac',
          '2',
          '-b:a',
          '96k',
          '-movflags',
          '+faststart',
          '-f',
          'mp4',
          part,
        ];
  const proc = run('ffmpeg', args, { nice: true, stdout: asset === 'proxy' ? 'pipe' : 'collect' });
  let lastWrite = 0;
  if (asset === 'proxy' && row.duration_s) {
    let buf = '';
    proc.child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const m = [...buf.matchAll(/out_time_us=(\d+)/g)].at(-1);
      buf = buf.slice(-200);
      if (!m || Date.now() - lastWrite < 2000) return;
      lastWrite = Date.now();
      const progress = Math.min(0.99, Number(m[1]) / 1e6 / (row.duration_s ?? 1));
      void pool
        .query(`update media_files set proxy_progress = $2 where id = $1 and proxy_state = 'running'`, [
          row.id,
          progress,
        ])
        .then(() => (taskId ? pool.query('update tasks set progress = $2 where id = $1', [taskId, progress]) : null))
        .then(() => notify(pool, row.torrent_id));
    });
  }
  try {
    const r = await watched(
      () => proc.done,
      () => stillRunning(pool, row.id, col),
      () => proc.child.kill('SIGKILL'),
    );
    if (r.code !== 0) throw new Error(`ffmpeg ${asset} failed: ${r.stderr.slice(0, 300)}`);
    if (!(await stillRunning(pool, row.id, col))) throw new Cancelled();
    await rename(part, join(out, name));
    const size = (await stat(join(out, name))).size;
    const fin = await pool.query(
      `update media_files mf set ${col} = 'ready', ${asset}_bytes = $2, ${asset === 'proxy' ? 'proxy_progress = 1,' : ''}
              reserve_bytes = case when mf.${asset === 'audio' ? 'proxy' : 'audio'}_state in ('pending', 'running') then $3 else 0 end,
              error = mf.error - '${asset}', updated_at = now()
         from torrents t
        where mf.id = $1 and mf.${col} = 'running' and t.id = mf.torrent_id and t.want <> 'remove'`,
      // What stays reserved is the other asset's share, if it is still to be made.
      [
        row.id,
        size,
        asset === 'audio'
          ? row.proxy_res
            ? assetReserve(row.duration_s, row.runtime_min, row.proxy_res)
            : 0
          : assetReserve(row.duration_s, row.runtime_min, 'audio'),
      ],
    );
    if (!fin.rowCount) {
      await removeOwnMediaOutput(config.dataDir, row.id, [name]);
      return 'skipped';
    }
    await notify(pool, row.torrent_id, true);
    return 'done';
  } catch (err) {
    await removeOwnMediaOutput(config.dataDir, row.id, [`${name}.part`]);
    if (err instanceof Cancelled) {
      if (taskId)
        await pool.query(
          `update tasks set state = 'cancelled', finished_at = now() where id = $1 and state in ('queued', 'running')`,
          [taskId],
        );
      return 'skipped';
    }
    d.log.warn({ media: row.id, asset, err: String(err).slice(0, 300) }, 'preview asset failed');
    return failAttempt(d, row, taskId, asset, 'TRANSCODE_FAILED');
  }
}

/**
 * First failure: back to pending, the task to queued with one attempt counted; the next
 * reconciliation runs it again. Second failure: failed, and its reservation is released
 * (docs/08, "失敗的工作自動再試一次").
 */
async function failAttempt(
  d: JobDeps,
  row: MediaRow,
  taskId: string | null,
  asset: 'analysis' | 'audio' | 'proxy',
  code: string,
): Promise<'retry' | 'failed'> {
  const { pool } = d;
  const col = `${asset}_state`;
  const task = taskId
    ? await one<{ attempts: number }>(pool, 'select attempts from tasks where id = $1', [taskId])
    : null;
  if (taskId && (task?.attempts ?? 0) === 0) {
    await pool.query(
      `update media_files set ${col} = 'pending', updated_at = now() where id = $1 and ${col} = 'running'`,
      [row.id],
    );
    await pool.query(`update tasks set state = 'queued', attempts = attempts + 1 where id = $1`, [taskId]);
    return 'retry';
  }
  const reserve =
    asset === 'analysis'
      ? null
      : `reserve_bytes = greatest(reserve_bytes - ${asset === 'audio' ? assetReserve(row.duration_s, row.runtime_min, 'audio') : row.proxy_res ? assetReserve(row.duration_s, row.runtime_min, row.proxy_res) : 0}, 0),`;
  await pool.query(
    `update media_files set ${col} = 'failed', ${reserve ?? ''} error = coalesce(error, '{}'::jsonb) || jsonb_build_object($2::text, $3::text), updated_at = now()
      where id = $1 and ${col} = 'running'`,
    [row.id, asset, code],
  );
  if (taskId)
    await pool.query(`update tasks set state = 'failed', error_code = $2, finished_at = now() where id = $1`, [
      taskId,
      code,
    ]);
  await notify(pool, row.torrent_id, asset !== 'analysis');
  return 'failed';
}

/* ================================================================ recalculate usage */

/**
 * Walks the disk, corrects the measured sizes, and reports orphans and missing files
 * (docs/10-storage.md, "重新計算用量"). It updates numbers and reports; it deletes nothing.
 */
export async function rescanJob(d: JobDeps, taskId: string): Promise<void> {
  const { pool, config } = d;
  const claimed = await pool.query(
    `update tasks set state = 'running', started_at = now() where id = $1 and state = 'queued'`,
    [taskId],
  );
  if (!claimed.rowCount) return;
  let corrected = 0;
  const torrents = await many<{
    id: string;
    info_hash: string;
    disk_bytes: number;
    state: string;
    rel_path: string | null;
  }>(
    pool,
    `select t.id, t.info_hash, t.disk_bytes, t.state, mf.rel_path from torrents t left join media_files mf on mf.torrent_id = t.id
      where t.state in ('completed', 'failed') and t.want <> 'remove'`,
  );
  const missing: { root: string; name: string; refId: string; subject: object }[] = [];
  for (const t of torrents) {
    const bytes = await folderBytes(join(config.dataDir, 'torrents', t.info_hash));
    if (bytes !== t.disk_bytes) {
      await pool.query('update torrents set disk_bytes = $2 where id = $1', [t.id, bytes]);
      corrected++;
    }
    if (t.state === 'completed' && t.rel_path) {
      const ok = await stat(join(config.dataDir, 'torrents', t.info_hash, t.rel_path)).then(
        () => true,
        () => false,
      );
      if (!ok) {
        const m = await one<{ title: string }>(
          pool,
          'select m.title from torrents t join movies m on m.id = t.movie_id where t.id = $1',
          [t.id],
        );
        missing.push({ root: 'torrents', name: t.info_hash, refId: t.id, subject: { movieTitle: m?.title ?? '' } });
      }
    }
  }
  const media = await many<{
    id: string;
    audio_state: string;
    audio_bytes: number;
    proxy_state: string;
    proxy_bytes: number;
    analysis_bytes: number;
  }>(pool, 'select id, audio_state, audio_bytes, proxy_state, proxy_bytes, analysis_bytes from media_files');
  for (const m of media) {
    const size = async (f: string) =>
      (await stat(join(config.dataDir, 'media', m.id, f)).catch(() => ({ size: 0 }))).size;
    const analysis =
      (await size('probe.json')) +
      (await size('peaks.bin')) +
      (await size('ref.npz')) +
      (await size('speech.json')) +
      (await size('asr.json'));
    const audio = m.audio_state === 'ready' ? await size('audio.m4a') : m.audio_bytes;
    const proxy = m.proxy_state === 'ready' ? await size('proxy.mp4') : m.proxy_bytes;
    if (analysis !== m.analysis_bytes || audio !== m.audio_bytes || proxy !== m.proxy_bytes) {
      await pool.query('update media_files set analysis_bytes = $2, audio_bytes = $3, proxy_bytes = $4 where id = $1', [
        m.id,
        analysis,
        audio,
        proxy,
      ]);
      corrected++;
    }
  }
  // Orphans: folders under each root with no row behind them.
  const known = {
    torrents: new Set((await many<{ v: string }>(pool, 'select info_hash as v from torrents')).map((r) => r.v)),
    media: new Set((await many<{ v: string }>(pool, 'select id::text as v from media_files')).map((r) => r.v)),
    subtitles: new Set((await many<{ v: string }>(pool, 'select id::text as v from subtitles')).map((r) => r.v)),
    candidates: new Set(
      (await many<{ v: string }>(pool, 'select id::text as v from subtitle_candidates')).map((r) => r.v),
    ),
    exports: new Set((await many<{ v: string }>(pool, 'select id::text as v from exports')).map((r) => r.v)),
  };
  const orphans: { root: keyof typeof known; name: string; bytes: number }[] = [];
  for (const root of Object.keys(known) as (keyof typeof known)[]) {
    const dir = root === 'candidates' ? join(config.dataDir, 'subtitles', 'candidates') : join(config.dataDir, root);
    const names = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of names) {
      if (!e.isDirectory() || (root === 'subtitles' && e.name === 'candidates')) continue;
      if (!known[root].has(e.name)) orphans.push({ root, name: e.name, bytes: await folderBytes(join(dir, e.name)) });
    }
  }
  await tx(pool, async (c) => {
    await c.query('delete from storage_findings');
    for (const o of orphans)
      await c.query(`insert into storage_findings (kind, root, name, bytes) values ('orphan', $1, $2, $3)`, [
        o.root,
        o.name,
        o.bytes,
      ]);
    for (const m of missing)
      await c.query(
        `insert into storage_findings (kind, root, name, ref_id, subject) values ('missing', $1, $2, $3, $4)`,
        [m.root, m.name, m.refId, m.subject],
      );
    await c.query(`update tasks set state = 'done', progress = 1, finished_at = now(), result = $2 where id = $1`, [
      taskId,
      { corrected, orphans: orphans.length, missing: missing.length },
    ]);
  });
  await pool.query(`select pg_notify('paiban_events', '{"type":"storage"}')`);
  await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
}
