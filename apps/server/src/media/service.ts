import { many, one } from '../db/pool.js';
import { cleanScratchOnStart } from '../storage/remove.js';
import { versionLabel } from '../torrents/view.js';
import { exportJob, finishCancelled } from './export-job.js';
import {
  analysisJob,
  asrJob,
  type JobDeps,
  MEDIA_ROW,
  type MediaRow,
  previewJob,
  probeJob,
  rescanJob,
} from './jobs.js';
import {
  alignJob,
  cleanStagingOnStart,
  failStuckFetches,
  ingestJob,
  isStaged,
  rankJob,
  settleRanks,
} from './subtitle-jobs.js';

/**
 * The media service's scheduling (docs/02-architecture.md "服務之間怎麼溝通", docs/08 "對帳").
 * The tables are the truth: a row in a waiting state is work to do. There is no separate queue;
 * a job claims its row with a conditional update, so running it twice does it once. Each kind of
 * work runs one at a time, so a long transcode never blocks analysis, an export or a recalculation.
 */
type Queue = 'analyze' | 'asr' | 'preview' | 'rescan' | 'export' | 'ingest' | 'rank' | 'align';
const QUEUES: Queue[] = ['analyze', 'asr', 'preview', 'rescan', 'export', 'ingest', 'rank', 'align'];

export class MediaService {
  private readonly d: JobDeps;
  private readonly busy = new Set<Queue>();
  private readonly again = new Set<Queue>();
  /** Media ids whose job failed once and waits for the next reconciliation before its second try. */
  private readonly cooling = new Map<string, number>();
  private stopping = false;

  constructor(d: JobDeps) {
    this.d = d;
  }

  /** Start-up (docs/02, "啟動與關閉"): drafts away, interrupted work back to waiting. */
  async start(): Promise<void> {
    const { pool, config, log } = this.d;
    await cleanScratchOnStart(config.dataDir, log);
    await cleanStagingOnStart(this.d);
    await pool.query(
      `update media_files set probe_state = case when probe_state = 'running' then 'pending' else probe_state end,
              analysis_state = case when analysis_state = 'running' then 'pending' else analysis_state end,
              audio_state = case when audio_state = 'running' then 'pending' else audio_state end,
              proxy_state = case when proxy_state = 'running' then 'pending' else proxy_state end,
              asr_state = case when asr_state = 'running' then 'pending' else asr_state end
        where 'running' in (probe_state, analysis_state, audio_state, proxy_state, asr_state)`,
    );
    // A cancellation the restart interrupted is finished now: nobody runs that export any more.
    const cancelled = await many<{ id: string }>(pool, `select id from exports where cancel_requested`);
    for (const e of cancelled) await finishCancelled(this.d, e.id);
    await pool.query(`update exports set state = 'queued', progress = 0 where state = 'running'`);
    await pool.query(`update subtitle_candidates set align_state = 'queued' where align_state = 'running'`);
    await pool.query(
      `update tasks set state = 'queued' where state = 'running' and kind in ('analyze', 'asr', 'preview', 'export', 'rank', 'rescan')`,
    );
    // Nobody waits for an interrupted alignment any more: the request that asked for it is gone.
    await pool.query(
      `update tasks set state = 'failed', error_code = 'TIMEOUT', finished_at = now() where kind = 'align' and state in ('queued', 'running')`,
    );
    await this.reconcile();
  }

  /** On start, on NOTIFY paiban_media, and every 60 s. Never deletes anything. */
  async reconcile(): Promise<void> {
    if (this.stopping) return;
    const { pool } = this.d;
    this.cooling.clear();
    // Tasks people can see for analysis and previews, created alongside the waiting rows.
    const need = await many<{
      id: string;
      torrent_id: string;
      title: string;
      quality: string;
      source_type: string;
      video_codec: string;
      kind: 'analyze' | 'asr' | 'preview';
    }>(
      pool,
      `select mf.id, mf.torrent_id, m.title, t.quality, t.source_type, t.video_codec, k.kind
         from media_files mf join torrents t on t.id = mf.torrent_id join movies m on m.id = t.movie_id
         cross join lateral (values ('analyze'), ('asr'), ('preview')) as k(kind)
        where t.want <> 'remove'
          and ((k.kind = 'analyze' and mf.analysis_state = 'pending')
            or (k.kind = 'asr' and mf.analysis_state = 'ready' and mf.asr_state = 'pending')
            or (k.kind = 'preview' and mf.probe_state <> 'failed' and 'pending' in (mf.audio_state, mf.proxy_state)))
          and not exists (select 1 from tasks x where x.kind = k.kind and x.input->>'mediaId' = mf.id::text and x.state in ('queued', 'running'))`,
    );
    for (const n of need)
      await pool.query(`insert into tasks (kind, torrent_id, subject, input) values ($1, $2, $3, $4)`, [
        n.kind,
        n.torrent_id,
        { movieTitle: n.title, version: versionLabel(n) },
        { mediaId: n.id },
      ]);
    // Tasks whose subject is gone (the film was removed): nothing to do any more.
    await pool.query(
      `update tasks set state = 'cancelled', finished_at = now()
        where state in ('queued', 'running') and kind in ('analyze', 'asr', 'preview')
          and not exists (select 1 from media_files mf join torrents t on t.id = mf.torrent_id
                           where mf.id::text = tasks.input->>'mediaId' and t.want <> 'remove')`,
    );
    // Export tasks whose export is gone or finished without them (deleted while waiting).
    await pool.query(
      `update tasks set state = 'cancelled', finished_at = now()
        where state in ('queued', 'running') and kind = 'export'
          and not exists (select 1 from exports e where e.id::text = tasks.input->>'exportId' and e.state in ('queued', 'running'))`,
    );
    if (need.length) await pool.query(`select pg_notify('paiban_events', '{"type":"task"}')`);
    // Subtitles: rankings whose candidates changed, candidates stuck while fetching (docs/08, "對帳" items 2 and 3).
    await settleRanks(pool);
    await failStuckFetches(pool);
    for (const q of QUEUES) this.kick(q);
  }

  kick(q: Queue): void {
    if (this.stopping) return;
    if (this.busy.has(q)) {
      this.again.add(q);
      return;
    }
    this.busy.add(q);
    void this.drain(q)
      .catch((err) => this.d.log.error({ err, queue: q }, 'media queue failed'))
      .finally(() => {
        this.busy.delete(q);
        if (this.again.delete(q)) this.kick(q);
      });
  }

  private async drain(q: Queue): Promise<void> {
    const tried = new Set<string>();
    for (;;) {
      if (this.stopping) return;
      const did =
        q === 'rescan'
          ? await this.nextRescan()
          : q === 'export'
            ? await this.nextExport()
            : q === 'analyze'
              ? await this.nextAnalysis()
              : q === 'asr'
                ? await this.nextAsr()
                : q === 'preview'
                  ? await this.nextPreview()
                  : q === 'ingest'
                    ? await this.nextIngest(tried)
                    : q === 'rank'
                      ? await this.nextRank(tried)
                      : await this.nextAlign();
      if (!did) return;
    }
  }

  /** An upload or a download the api staged (docs/07, "subtitle.ingest" and the processing half of "subtitle.fetch"). */
  private async nextIngest(tried: Set<string>): Promise<boolean> {
    const rows = await many<{ id: string }>(
      this.d.pool,
      `select c.id from subtitle_candidates c join torrents t on t.id = c.torrent_id
        where c.fetch_state = 'fetching' and t.want <> 'remove' order by c.fetch_started_at`,
    );
    for (const r of rows) {
      if (tried.has(r.id)) continue;
      tried.add(r.id);
      if (!(await isStaged(this.d.config.dataDir, r.id))) continue;
      await ingestJob(this.d, r.id);
      this.kick('rank');
      return true;
    }
    return false;
  }

  /** A fetched candidate waiting in an unfinished ranking run. */
  private async nextRank(tried: Set<string>): Promise<boolean> {
    const r = await one<{ id: string }>(
      this.d.pool,
      `select c.id from subtitle_candidates c join torrents t on t.id = c.torrent_id
        where c.align_state = 'queued' and c.fetch_state = 'ready' and t.want <> 'remove' and not (c.id = any($1::uuid[]))
          and exists (select 1 from tasks k where k.kind = 'rank' and k.torrent_id = c.torrent_id and k.state in ('queued', 'running')
                        and k.input->'candidateIds' ? c.id::text)
        order by c.created_at limit 1`,
      [[...tried]],
    );
    if (!r) return false;
    tried.add(r.id);
    await rankJob(this.d, r.id);
    return true;
  }

  private async nextAlign(): Promise<boolean> {
    const t = await one<{ id: string }>(
      this.d.pool,
      `select id from tasks where kind = 'align' and state = 'queued' order by created_at limit 1`,
    );
    if (!t) return false;
    await alignJob(this.d, t.id);
    return true;
  }

  private cool(id: string): boolean {
    return (this.cooling.get(id) ?? 0) > Date.now();
  }

  private async task(kind: 'analyze' | 'asr' | 'preview', mediaId: string): Promise<string | null> {
    const t = await one<{ id: string }>(
      this.d.pool,
      `select id from tasks where kind = $1 and input->>'mediaId' = $2 and state in ('queued', 'running') order by created_at limit 1`,
      [kind, mediaId],
    );
    return t?.id ?? null;
  }

  private async nextAnalysis(): Promise<boolean> {
    const rows = await many<MediaRow>(
      this.d.pool,
      `${MEDIA_ROW} where t.want <> 'remove' and (mf.probe_state = 'pending' or (mf.probe_state = 'ready' and mf.analysis_state = 'pending'))
        order by mf.created_at`,
    );
    const row = rows.find((r) => !this.cool(r.id));
    if (!row) return false;
    if (row.probe_state === 'pending') {
      await probeJob(this.d, row);
      this.kick('preview');
      return true;
    }
    const result = await analysisJob(this.d, row, await this.task('analyze', row.id));
    if (result === 'retry') this.cooling.set(row.id, Date.now() + 60_000);
    if (result === 'skipped') this.cooling.set(row.id, Date.now() + 5_000);
    // Recognition is queued now: reconciling gives it its task row, then starts it.
    if (result === 'done') void this.reconcile().catch((err) => this.d.log.error({ err }, 'reconcile failed'));
    return true;
  }

  /** Speech recognition, after the analysis (docs/08, "語音辨識"). Its own queue: it takes minutes. */
  private async nextAsr(): Promise<boolean> {
    const rows = await many<MediaRow>(
      this.d.pool,
      `${MEDIA_ROW} where t.want <> 'remove' and mf.analysis_state = 'ready' and mf.asr_state = 'pending' order by mf.created_at`,
    );
    const row = rows.find((r) => !this.cool(`asr:${r.id}`));
    if (!row) return false;
    const result = await asrJob(this.d, row, await this.task('asr', row.id));
    if (result === 'skipped') this.cooling.set(`asr:${row.id}`, Date.now() + 5_000);
    return true;
  }

  private async nextPreview(): Promise<boolean> {
    const rows = await many<MediaRow>(
      this.d.pool,
      `${MEDIA_ROW} where t.want <> 'remove' and mf.probe_state = 'ready' and 'pending' in (mf.audio_state, mf.proxy_state) order by mf.created_at`,
    );
    const row = rows.find((r) => !this.cool(r.id));
    if (!row) return false;
    const result = await previewJob(this.d, row, await this.task('preview', row.id));
    if (result === 'retry') this.cooling.set(row.id, Date.now() + 60_000);
    if (result === 'skipped') this.cooling.set(row.id, Date.now() + 5_000);
    return true;
  }

  /** One export at a time, independent of the preview queue (docs/08-media-pipeline.md, "封裝"). */
  private async nextExport(): Promise<boolean> {
    const rows = await many<{ id: string }>(
      this.d.pool,
      `select e.id from exports e join torrents t on t.id = e.torrent_id
        where e.state = 'queued' and not e.cancel_requested and t.want <> 'remove' order by e.created_at`,
    );
    const row = rows.find((r) => !this.cool(r.id));
    if (!row) return false;
    const result = await exportJob(this.d, row.id);
    if (result === 'retry') this.cooling.set(row.id, Date.now() + 60_000);
    if (result === 'skipped') this.cooling.set(row.id, Date.now() + 5_000);
    return true;
  }

  private async nextRescan(): Promise<boolean> {
    const t = await one<{ id: string }>(
      this.d.pool,
      `select id from tasks where kind = 'rescan' and state = 'queued' order by created_at limit 1`,
    );
    if (!t) return false;
    await rescanJob(this.d, t.id);
    return true;
  }

  /** SIGTERM: stop taking work. A running ffmpeg is stopped by the process exit; start-up cleans up. */
  stop(): void {
    this.stopping = true;
  }
}
