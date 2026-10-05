import type { ServiceStatus, StorageFinding, Task, TaskKind } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, tx } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin } from '../http/guards.js';
import { assetReserve } from '../media/probe.js';
import { readSettings } from '../settings/settings.js';
import { admit, diskInfo } from '../storage/usage.js';

type TaskRow = {
  id: string;
  kind: TaskKind;
  subject: Task['subject'];
  input: { mediaId?: string };
  state: Task['state'];
  progress: number;
  error_code: string | null;
  result: Record<string, number> | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
};

const RETRYABLE: TaskKind[] = ['analyze', 'preview', 'rescan'];

export function toTask(r: TaskRow): Task {
  return {
    id: r.id,
    kind: r.kind,
    subject: r.subject,
    state: r.state,
    progress: r.progress,
    errorCode: r.error_code,
    retryable: r.state === 'failed' && RETRYABLE.includes(r.kind),
    summary: r.kind === 'rescan' && r.result ? r.result : null,
    seconds:
      r.started_at && r.finished_at ? Math.round((r.finished_at.getTime() - r.started_at.getTime()) / 1000) : null,
    createdAt: r.created_at.toISOString(),
  };
}

const TASKS =
  'select id, kind, subject, input, state, progress, error_code, result, created_at, started_at, finished_at from tasks';

/** docs/11-pages.md, "系統狀態" and the storage page's recalculation. */
export function systemRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  app.get('/api/admin/system', async (req) => {
    requireAdmin(req);
    const beats = await many<{ service: string; started_at: Date; last_seen_at: Date; version: string }>(
      pool,
      'select service, started_at, last_seen_at, version from service_heartbeats',
    );
    const services: ServiceStatus[] = (['api', 'torrent', 'media'] as const).map((name) => {
      const b = beats.find((x) => x.service === name);
      const up = !!b && Date.now() - b.last_seen_at.getTime() < 30_000;
      return {
        name,
        state: up ? 'up' : 'down',
        since: b ? b.started_at.toISOString() : null,
        version: b?.version ?? null,
      };
    });
    // The page loaded through the api, so the database answered just now.
    const pgStart = await one<{ since: Date }>(pool, 'select pg_postmaster_start_time() as since');
    services.push({ name: 'postgres', state: 'up', since: pgStart?.since.toISOString() ?? null, version: null });
    const tasks = (await many<TaskRow>(pool, `${TASKS} order by created_at desc limit 50`)).map(toTask);
    return { services, tasks, disk: await diskInfo(pool, deps.disk, config.storageReserveBytes) };
  });

  /** docs/08-media-pipeline.md, "手動重試": a new task; the failed one stays as a record. */
  app.post('/api/admin/tasks/:id/retry', async (req) => {
    const admin = requireAdmin(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const t = await one<TaskRow>(pool, `${TASKS} where id = $1`, [id]);
    if (!t) throw new ApiError('NOT_FOUND', 'no such task');
    if (t.state !== 'failed' || !RETRYABLE.includes(t.kind))
      throw new ApiError('VALIDATION', 'only failed analysis, preview and recalculation tasks can be retried', {
        fields: { id: 'NOT_RETRYABLE' },
      });
    const mediaId = t.input.mediaId;
    if (t.kind === 'analyze' && mediaId) {
      await pool.query(
        `update media_files set analysis_state = 'pending', error = error - 'analysis',
                probe_state = case when probe_state = 'failed' then 'pending' else probe_state end where id = $1 and analysis_state in ('none', 'failed')`,
        [mediaId],
      );
    } else if (t.kind === 'preview' && mediaId) {
      // Its reservation was released when it failed: it has to pass admission again.
      const { media } = await readSettings(pool);
      await tx(pool, async (c) => {
        const m = await one<{
          audio_state: string;
          proxy_state: string;
          proxy_res: '480p' | '720p' | null;
          duration_s: number | null;
          runtime_min: number;
        }>(
          c,
          `select mf.audio_state, mf.proxy_state, mf.proxy_res, mf.duration_s, mv.runtime_min
             from media_files mf join torrents t on t.id = mf.torrent_id join movies mv on mv.id = t.movie_id
            where mf.id = $1 and t.want <> 'remove' for update of mf`,
          [mediaId],
        );
        if (!m) throw new ApiError('NOT_FOUND', 'the film is gone');
        const audio = m.audio_state === 'failed';
        const proxy = m.proxy_state === 'failed';
        const res = m.proxy_res ?? media.proxyResolution;
        const bytes =
          (audio ? assetReserve(m.duration_s, m.runtime_min, 'audio') : 0) +
          (proxy ? assetReserve(m.duration_s, m.runtime_min, res) : 0);
        if (bytes > 0) await admit(c, deps.disk, config.storageReserveBytes, { bytes, previewBytes: bytes });
        await c.query(
          `update media_files set audio_state = case when $2 then 'pending' else audio_state end, proxy_state = case when $3 then 'pending' else proxy_state end,
                  reserve_bytes = reserve_bytes + $4, error = error - 'audio' - 'proxy' where id = $1`,
          [mediaId, audio, proxy, bytes],
        );
      });
    } else if (t.kind === 'rescan') {
      await pool.query(`insert into tasks (kind, subject, created_by) values ('rescan', '{}', $1)`, [admin.id]);
    }
    await audit(pool, admin, 'admin.task.retry', { kind: t.kind, movieTitle: t.subject.movieTitle ?? '' }, req.ip);
    await pool.query(`select pg_notify('paiban_media', '{}')`);
    deps.events.toAdmins({ type: 'admin', what: 'tasks' });
    return toTask(t);
  });

  /** Recalculate usage: a background task; one at a time. It reports and corrects numbers, never deletes. */
  app.post('/api/admin/storage/rescan', async (req) => {
    const admin = requireAdmin(req);
    const running = await one<TaskRow>(
      pool,
      `${TASKS} where kind = 'rescan' and state in ('queued', 'running') order by created_at limit 1`,
    );
    if (running) return toTask(running);
    const t = await one<TaskRow>(
      pool,
      `insert into tasks (kind, subject, created_by) values ('rescan', '{}', $1) returning id, kind, subject, input, state, progress, error_code, result, created_at, started_at, finished_at`,
      [admin.id],
    );
    if (!t) throw new Error('insert returned nothing');
    await audit(pool, admin, 'admin.storage.rescan', {}, req.ip);
    await pool.query(`select pg_notify('paiban_media', '{}')`);
    return toTask(t);
  });
}

export async function storageFindings(deps: Deps): Promise<{ findings: StorageFinding[]; rescan: Task | null }> {
  const rows = await many<{
    id: string;
    kind: 'orphan' | 'missing';
    root: StorageFinding['root'];
    name: string;
    bytes: number;
    ref_id: string | null;
    subject: { movieTitle?: string; fileName?: string };
    found_at: Date;
  }>(
    deps.pool,
    'select id, kind, root, name, bytes, ref_id, subject, found_at from storage_findings order by kind, root, name',
  );
  const last = await one<TaskRow>(deps.pool, `${TASKS} where kind = 'rescan' order by created_at desc limit 1`);
  return {
    findings: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      root: r.root,
      name: r.name,
      bytes: r.bytes,
      refId: r.ref_id,
      movieTitle: r.subject.movieTitle ?? null,
      fileName: r.subject.fileName ?? null,
      foundAt: r.found_at.toISOString(),
    })),
    rescan: last ? toTask(last) : null,
  };
}
