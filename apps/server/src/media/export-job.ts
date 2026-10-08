import { rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExportErrorCode } from '@paiban/shared';
import { one, type Pool } from '../db/pool.js';
import { type TrackRecord, trackTag } from '../exports/view.js';
import { removeExportTracks, removeOwnExportOutput } from '../storage/remove.js';
import type { JobDeps } from './jobs.js';
import { type StreamCounts, streamCounts } from './probe.js';
import { Cancelled, run, watched } from './proc.js';

/**
 * The export job, `export.mux` (docs/08-media-pipeline.md, "封裝"). The original video and audio
 * are copied untouched next to the confirmed subtitles the api wrote into tracks/ when the export
 * was created. Same rules as the other media jobs: claim with a conditional update, check every
 * two seconds that the export is still wanted, write .part then rename, finish with a conditional
 * update or remove what was just written.
 */

class MuxFailure extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode) {
    super(code);
    this.code = code;
  }
}

export type MuxTrack = { file: string; language: string; title: string };

/**
 * The ffmpeg arguments of reference/pipeline/mux.sh, option for option: `0:V` (real video only,
 * no cover art), `0:a?` (every audio track, none is fine), each subtitle file as its own input,
 * `-c copy`, the first track the default, progress on stdout.
 */
export function muxArgs(src: string, out: string, tracks: MuxTrack[], title: string | null): string[] {
  const inputs = ['-i', src];
  const maps = ['-map', '0:V', '-map', '0:a?'];
  const meta: string[] = [];
  tracks.forEach((t, n) => {
    inputs.push('-i', t.file);
    maps.push('-map', `${n + 1}:0`);
    meta.push(
      `-metadata:s:s:${n}`,
      `language=${t.language}`,
      `-metadata:s:s:${n}`,
      `title=${t.title}`,
      `-disposition:s:${n}`,
      n === 0 ? 'default' : '0',
    );
  });
  if (title) meta.push('-metadata', `title=${title}`);
  return [
    '-v',
    'error',
    '-nostdin',
    '-y',
    '-progress',
    'pipe:1',
    '-nostats',
    ...inputs,
    ...maps,
    '-c',
    'copy',
    ...meta,
    '-f',
    'matroska',
    out,
  ];
}

type JobRow = {
  id: string;
  torrent_id: string;
  file_name: string;
  tracks: TrackRecord[];
  movie_title: string;
  version_label: string;
  created_by: string | null;
  info_hash: string | null;
  rel_path: string | null;
  duration_s: number | null;
  title: string;
  year: number;
};

async function events(pool: Pool, ...msgs: object[]): Promise<void> {
  for (const m of msgs) await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify(m)]);
}

async function stillWanted(pool: Pool, id: string): Promise<boolean> {
  const r = await one<{ ok: boolean }>(
    pool,
    `select (e.state = 'running' and not e.cancel_requested and t.want <> 'remove') as ok
       from exports e join torrents t on t.id = e.torrent_id where e.id = $1`,
    [id],
  );
  return !!r?.ok;
}

async function probeCounts(file: string): Promise<StreamCounts | null> {
  const r = await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file]).done;
  if (r.code !== 0) return null;
  try {
    return streamCounts(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

const exists = (p: string) =>
  stat(p).then(
    (s) => s.isFile(),
    () => false,
  );

export async function exportJob(d: JobDeps, id: string): Promise<'done' | 'failed' | 'retry' | 'skipped'> {
  const { pool, config, log } = d;
  const claimed = await pool.query(
    `update exports e set state = 'running', progress = 0 from torrents t
      where e.id = $1 and e.state = 'queued' and not e.cancel_requested and t.id = e.torrent_id and t.want <> 'remove'`,
    [id],
  );
  if (!claimed.rowCount) return 'skipped';
  const task = await one<{ id: string; attempts: number }>(
    pool,
    `select id, attempts from tasks where kind = 'export' and input->>'exportId' = $1 and state in ('queued', 'running') order by created_at limit 1`,
    [id],
  );
  if (task)
    await pool.query(`update tasks set state = 'running', started_at = coalesce(started_at, now()) where id = $1`, [
      task.id,
    ]);
  await events(pool, { type: 'export', id }, { type: 'task', id: task?.id ?? '' });

  const row = await one<JobRow>(
    pool,
    `select e.id, e.torrent_id, e.file_name, e.tracks, e.movie_title, e.version_label, e.created_by,
            t.info_hash, mf.rel_path, mf.duration_s, m.title, m.year
       from exports e join torrents t on t.id = e.torrent_id join movies m on m.id = t.movie_id
       left join media_files mf on mf.torrent_id = t.id
      where e.id = $1`,
    [id],
  );
  if (!row) return stopped(d, id, task?.id ?? null);
  const dir = join(config.dataDir, 'exports', id);
  const part = `${row.file_name}.part`;
  try {
    if (!row.info_hash || !row.rel_path) throw new MuxFailure('SOURCE_MISSING');
    const src = join(config.dataDir, 'torrents', row.info_hash, row.rel_path);
    if (!(await exists(src))) throw new MuxFailure('SOURCE_MISSING');
    const before = await probeCounts(src);
    if (!before) throw new MuxFailure('MUX_FAILED');
    const tracks: MuxTrack[] = row.tracks.map((t, n) => ({
      file: join(dir, 'tracks', `${n}.srt`),
      language: trackTag(t.language).language,
      // The title was written when the export was made, in its maker's language.
      title: t.title || trackTag(t.language).title,
    }));
    for (const t of tracks) if (!(await exists(t.file))) throw new MuxFailure('MUX_FAILED');

    const proc = run('ffmpeg', muxArgs(src, join(dir, part), tracks, `${row.title} (${row.year})`), {
      nice: true,
      stdout: 'pipe',
    });
    let lastWrite = 0;
    let buf = '';
    proc.child.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const m = [...buf.matchAll(/out_time_us=(\d+)/g)].at(-1);
      buf = buf.slice(-200);
      if (!m || !row.duration_s || Date.now() - lastWrite < 2000) return;
      lastWrite = Date.now();
      const progress = Math.max(0, Math.min(0.99, Number(m[1]) / 1e6 / row.duration_s));
      void pool
        .query(`update exports set progress = $2 where id = $1 and state = 'running'`, [id, progress])
        .then(() => (task ? pool.query('update tasks set progress = $2 where id = $1', [task.id, progress]) : null))
        .then(() => events(pool, { type: 'export', id }))
        .catch(() => undefined);
    });
    const r = await watched(
      () => proc.done,
      () => stillWanted(pool, id),
      () => proc.child.kill('SIGKILL'),
    );
    if (r.code !== 0) {
      log.warn({ export: id, stderr: r.stderr.slice(0, 300) }, 'ffmpeg mux failed');
      throw new MuxFailure(/no space left/i.test(r.stderr) ? 'DISK_FULL' : 'MUX_FAILED');
    }
    // Checked once before the name becomes final (docs/08, "做完之後檢查一次").
    const after = await probeCounts(join(dir, part));
    if (!after || after.video !== before.video || after.audio !== before.audio || after.subtitle !== row.tracks.length)
      throw new MuxFailure('VERIFY_FAILED');
    if (!(await stillWanted(pool, id))) throw new Cancelled();
    await rename(join(dir, part), join(dir, row.file_name));
    const size = (await stat(join(dir, row.file_name))).size;
    const fin = await pool.query(
      `update exports e set state = 'done', size_bytes = $2, reserved_bytes = 0, progress = 1, rel_path = $3, completed_at = now()
         from torrents t
        where e.id = $1 and e.state = 'running' and not e.cancel_requested and t.id = e.torrent_id and t.want <> 'remove'`,
      [id, size, `exports/${id}/${row.file_name}`],
    );
    if (!fin.rowCount) {
      await removeOwnExportOutput(config.dataDir, id, row.file_name);
      return stopped(d, id, task?.id ?? null);
    }
    await removeExportTracks(config.dataDir, id);
    if (task)
      await pool.query(`update tasks set state = 'done', progress = 1, finished_at = now() where id = $1`, [task.id]);
    const note = row.created_by
      ? await one<{ id: number }>(
          pool,
          `insert into notifications (user_id, kind, data, link) values ($1, 'export.completed', $2, $3) returning id`,
          [
            row.created_by,
            { movieTitle: row.movie_title, version: row.version_label, fileName: row.file_name },
            { page: 'workspace', torrentId: row.torrent_id, tab: 'export' },
          ],
        )
      : null;
    await events(
      pool,
      { type: 'export', id },
      { type: 'usage' },
      { type: 'task', id: task?.id ?? '' },
      ...(note ? [{ type: 'notification', id: String(note.id) }] : []),
    );
    return 'done';
  } catch (err) {
    await removeOwnExportOutput(config.dataDir, id, part);
    if (err instanceof Cancelled) return stopped(d, id, task?.id ?? null);
    const code = err instanceof MuxFailure ? err.code : 'MUX_FAILED';
    if (!(err instanceof MuxFailure)) log.warn({ export: id, err: String(err).slice(0, 300) }, 'export failed');
    return failAttempt(d, row, task, code);
  }
}

/**
 * The export stopped being wanted while it ran (docs/08, "結束的四種情況"): cancelled by a person
 * (remove the tracks and the row), or its film was removed (the torrent service already marked it
 * failed; only the tracks are left to remove). The .part is already gone.
 */
async function stopped(d: JobDeps, id: string, taskId: string | null): Promise<'skipped'> {
  const { pool, config } = d;
  await removeExportTracks(config.dataDir, id);
  const gone = await pool.query(`delete from exports where id = $1 and cancel_requested`, [id]);
  if (taskId)
    await pool.query(
      `update tasks set state = 'cancelled', finished_at = now() where id = $1 and state in ('queued', 'running')`,
      [taskId],
    );
  await events(
    pool,
    gone.rowCount ? { type: 'export.removed', id } : { type: 'export', id },
    { type: 'usage' },
    { type: 'task', id: taskId ?? '' },
  );
  return 'skipped';
}

/**
 * A cancellation that a restart interrupted: the row still says cancel_requested and nobody runs
 * it any more. Called by the media service at start-up; the .part is already cleaned by then.
 */
export async function finishCancelled(d: JobDeps, id: string): Promise<void> {
  await stopped(d, id, null);
  await d.pool.query(
    `update tasks set state = 'cancelled', finished_at = now() where kind = 'export' and input->>'exportId' = $1 and state in ('queued', 'running')`,
    [id],
  );
}

/**
 * First failure: back to queued, tracks and reservation kept, the task counts one attempt; the next
 * reconciliation tries again. Second failure, or a missing source (not retried): failed, the
 * reservation released, the tracks removed, the creator told (docs/08, "失敗的工作自動再試一次").
 */
async function failAttempt(
  d: JobDeps,
  row: JobRow,
  task: { id: string; attempts: number } | null,
  code: ExportErrorCode,
): Promise<'retry' | 'failed' | 'skipped'> {
  const { pool, config } = d;
  if (task && task.attempts === 0 && code !== 'SOURCE_MISSING') {
    const back = await pool.query(
      `update exports set state = 'queued', progress = 0 where id = $1 and state = 'running' and not cancel_requested`,
      [row.id],
    );
    if (!back.rowCount) return stopped(d, row.id, task.id);
    await pool.query(`update tasks set state = 'queued', progress = 0, attempts = attempts + 1 where id = $1`, [
      task.id,
    ]);
    await events(pool, { type: 'export', id: row.id }, { type: 'task', id: task.id });
    return 'retry';
  }
  const failed = await pool.query(
    `update exports set state = 'failed', error_code = $2, reserved_bytes = 0, progress = 0
      where id = $1 and state = 'running' and not cancel_requested`,
    [row.id, code],
  );
  if (!failed.rowCount) return stopped(d, row.id, task?.id ?? null);
  await removeExportTracks(config.dataDir, row.id);
  if (task)
    await pool.query(`update tasks set state = 'failed', error_code = $2, finished_at = now() where id = $1`, [
      task.id,
      code,
    ]);
  const note = row.created_by
    ? await one<{ id: number }>(
        pool,
        `insert into notifications (user_id, kind, data, link) values ($1, 'export.failed', $2, $3) returning id`,
        [
          row.created_by,
          { movieTitle: row.movie_title, version: row.version_label, fileName: row.file_name, errorCode: code },
          { page: 'workspace', torrentId: row.torrent_id, tab: 'export' },
        ],
      )
    : null;
  await events(
    pool,
    { type: 'export', id: row.id },
    { type: 'usage' },
    { type: 'task', id: task?.id ?? '' },
    ...(note ? [{ type: 'notification', id: String(note.id) }] : []),
  );
  return 'failed';
}
