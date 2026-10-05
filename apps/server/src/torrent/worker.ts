import { mkdir } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { SIZE_SLACK_BYTES } from '@paiban/shared';
import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { many, one, type Pool, tx } from '../db/pool.js';
import { readSettings } from '../settings/settings.js';
import type { DiskProbe } from '../storage/disk.js';
import { folderBytes } from '../storage/measure.js';
import { removeDownloadFiles, removeExportTracks, removePoster } from '../storage/remove.js';
import { admit, predictDirectPlay } from '../storage/usage.js';
import { versionLabel } from '../torrents/view.js';
import type { Engine, EngineTorrent } from './engine.js';
import { mainVideo, pathsAreSafe, pickToStart, stalled } from './schedule.js';

/**
 * The torrent service (docs/06-torrent-worker.md): makes `state` follow `want`, schedules, writes
 * progress, finishes, fails and removes. It never decides on its own to delete anything; the only
 * deletion it performs is of rows a person marked `want = 'remove'`.
 */
type Active = {
  id: string;
  hash: string;
  t: EngineTorrent;
  startedAt: number;
  lastProgressAt: number;
  hasMetadata: boolean;
  busy: boolean;
};

type Row = {
  id: string;
  info_hash: string;
  state: string;
  want: string;
  size_bytes: number;
  length_bytes: number | null;
  downloaded_bytes: number;
  bitfield: Buffer | null;
  clean_stop: boolean;
  seeding: boolean;
  title: string;
  year: number;
  quality: string;
  source_type: string;
  video_codec: string;
  bit_depth: number;
  requested_by: string | null;
};

const ROW = `select t.id, t.info_hash, t.state, t.want, t.size_bytes, t.length_bytes, t.downloaded_bytes, t.bitfield, t.clean_stop, t.seeding,
                    m.title, m.year, t.quality, t.source_type, t.video_codec, t.bit_depth, t.requested_by
               from torrents t join movies m on m.id = t.movie_id`;

export type WorkerDeps = {
  pool: Pool;
  config: Config;
  log: Logger;
  engine: Engine;
  disk: DiskProbe;
  now?: () => number;
};

export class TorrentWorker {
  private readonly pool: Pool;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly engine: Engine;
  private readonly disk: DiskProbe;
  private readonly now: () => number;
  private readonly active = new Map<string, Active>();
  private readonly seeding = new Map<string, EngineTorrent>();
  private chain: Promise<void> = Promise.resolve();
  private stopping = false;
  private throttleKey = '';
  lastIncomingAt: string | null = null;

  constructor(d: WorkerDeps) {
    this.pool = d.pool;
    this.config = d.config;
    this.log = d.log;
    this.engine = d.engine;
    this.disk = d.disk;
    this.now = d.now ?? Date.now;
  }

  private torrentDir(hash: string): string {
    return join(this.config.dataDir, 'torrents', hash);
  }

  /** Start-up (docs/06, "重啟"): resume what was downloading, re-add what is seeding. */
  async recover(): Promise<void> {
    const rows = await many<Row>(
      this.pool,
      `${ROW} where t.want <> 'remove' and (t.state = 'downloading' or (t.state = 'completed' and t.seeding))`,
    );
    for (const r of rows) {
      if (r.state === 'completed') {
        const t = this.engine.add(this.magnet(r, []), { path: this.torrentDir(r.info_hash), skipVerify: true });
        this.watchTestPeers(t);
        this.seeding.set(r.id, t);
        continue;
      }
      // A bitfield is trusted only if it was saved by a clean stop; otherwise WebTorrent re-verifies.
      const trusted = r.clean_stop && r.bitfield ? r.bitfield : undefined;
      await this.pool.query(
        `update torrents set clean_stop = false, phase = $2, last_progress_at = now() where id = $1`,
        [r.id, trusted ? 'metadata' : 'verifying'],
      );
      await this.attach(r, trusted, (await readSettings(this.pool)).downloads.trackers);
    }
  }

  /** One pass of the loop. Passes never overlap; a request during a pass queues one more. */
  tick(): Promise<void> {
    this.chain = this.chain.then(() => this.pass()).catch((err) => this.log.error({ err }, 'torrent loop pass failed'));
    return this.chain;
  }

  private async pass(): Promise<void> {
    if (this.stopping) return;
    const settings = await readSettings(this.pool);

    // 1. removals
    for (const r of await many<Row>(this.pool, `${ROW} where t.want = 'remove'`)) await this.remove(r);

    // 2. pauses
    for (const r of await many<Row>(
      this.pool,
      `${ROW} where t.want = 'pause' and t.state in ('queued', 'downloading')`,
    )) {
      if (r.state === 'queued') {
        await this.pool.query(
          `update torrents set state = 'paused' where id = $1 and state = 'queued' and want = 'pause'`,
          [r.id],
        );
        await this.wake(r.id);
      } else await this.pause(r.id);
    }

    // 3. resumes go to the back of the queue
    const resumed = await many<{ id: string }>(
      this.pool,
      `update torrents set state = 'queued', queued_at = now() where want = 'run' and state = 'paused' returning id`,
    );
    for (const r of resumed) await this.wake(r.id);

    // 4. scheduling
    await this.schedule(settings.downloads.maxActive, settings.downloads.maxPerUser, settings.downloads.trackers);

    // 5. progress and stalls
    for (const a of [...this.active.values()]) await this.progress(a, settings.downloads.stallMinutes);
    for (const [id, t] of this.seeding) await this.seedProgress(id, t, settings.downloads.seedMode);

    // 6. speed limits
    const key = `${settings.downloads.downloadLimitKB}/${settings.downloads.uploadLimitKB}`;
    if (key !== this.throttleKey) {
      this.engine.throttle(settings.downloads.downloadLimitKB * 1024, settings.downloads.uploadLimitKB * 1024);
      this.throttleKey = key;
    }
  }

  private async schedule(maxActive: number, maxPerUser: number, trackers: string[]): Promise<void> {
    const queued = await many<Row & { holds: boolean }>(
      this.pool,
      `${ROW.replace('select ', 'select exists (select 1 from torrent_holders h where h.torrent_id = t.id and h.user_id = t.requested_by) as holds, ')}
        where t.state = 'queued' and t.want = 'run' order by t.queued_at`,
    );
    if (queued.length === 0) return;
    const running = await many<{ requested_by: string | null; holds: boolean }>(
      this.pool,
      `select t.requested_by, exists (select 1 from torrent_holders h where h.torrent_id = t.id and h.user_id = t.requested_by) as holds
         from torrents t where t.state = 'downloading' and t.want <> 'remove'`,
    );
    const perUser = new Map<string, number>();
    for (const r of running)
      if (r.requested_by && r.holds) perUser.set(r.requested_by, (perUser.get(r.requested_by) ?? 0) + 1);
    const ids = pickToStart(
      queued.map((q) => ({ id: q.id, requestedBy: q.requested_by, requesterHolds: q.holds })),
      perUser,
      running.length,
      { maxActive, maxPerUser },
    );
    for (const id of ids) {
      const r = queued.find((q) => q.id === id);
      if (r) await this.begin(r, trackers);
    }
  }

  /** Starting one download (docs/06, "開始一個下載"). */
  private async begin(r: Row, trackers: string[]): Promise<void> {
    const res = await this.pool.query(
      `update torrents set state = 'downloading', phase = 'metadata', started_at = now(), last_progress_at = now(), clean_stop = false
        where id = $1 and state = 'queued' and want = 'run'`,
      [r.id],
    );
    if (res.rowCount === 0) return;
    const remaining = Math.max(0, Math.max(r.size_bytes, r.length_bytes ?? 0) - r.downloaded_bytes);
    const { availableBytes } = await this.disk();
    if (availableBytes - this.config.storageReserveBytes < remaining) {
      await this.markFailed(r.id, null, 'DISK_FULL', `need ${remaining} bytes, ${availableBytes} available`);
      return;
    }
    await mkdir(this.torrentDir(r.info_hash), { recursive: true });
    // A bitfield from a clean stop lets a retried or resumed download continue where it was.
    await this.attach(r, r.clean_stop && r.bitfield ? r.bitfield : undefined, trackers);
    await this.wake(r.id);
  }

  private magnet(r: Pick<Row, 'info_hash' | 'title' | 'year' | 'quality'>, trackers: string[]): string {
    const dn = encodeURIComponent(`${r.title} ${r.year} ${r.quality}`);
    const tr = this.config.torrentTestPeers.length ? [] : trackers;
    return `magnet:?xt=urn:btih:${r.info_hash}&dn=${dn}${tr.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
  }

  private watchTestPeers(t: EngineTorrent): void {
    if (!this.config.torrentTestPeers.length) return;
    // addPeer() throws before the infoHash event (reference/torrent/local-swarm-test.mjs).
    t.on('infoHash', () => {
      for (const p of this.config.torrentTestPeers) t.addPeer(p);
    });
  }

  private async attach(r: Row, bitfield: Buffer | undefined, trackers: string[]): Promise<void> {
    const t = this.engine.add(this.magnet(r, trackers), {
      path: this.torrentDir(r.info_hash),
      ...(bitfield ? { bitfield } : {}),
    });
    const a: Active = {
      id: r.id,
      hash: r.info_hash,
      t,
      startedAt: this.now(),
      lastProgressAt: this.now(),
      hasMetadata: false,
      busy: false,
    };
    this.active.set(r.id, a);
    this.watchTestPeers(t);
    t.on('metadata', () => void this.onMetadata(a));
    t.on('download', () => {
      a.lastProgressAt = this.now();
    });
    t.on('wire', (type) => {
      // Only TCP proves the port is reachable: an incoming uTP (UDP) connection can come through the
      // NAT mapping our own outgoing traffic opened (phase 0, docs/agent-notes.md).
      if (type === 'tcpIncoming') this.lastIncomingAt = new Date(this.now()).toISOString();
    });
    t.on('warning', (err) =>
      this.log.warn({ torrent: r.id, warning: String(err?.message ?? err).slice(0, 200) }, 'torrent warning'),
    );
    t.on('error', (err) => {
      const code = /ENOSPC/.test(String(err?.message)) ? 'DISK_FULL' : 'IO_ERROR';
      void this.fail(a, code, String(err?.message ?? err));
    });
    t.on('done', () => void this.complete(a));
  }

  /** Checks once the torrent's own metadata arrives (docs/06, "拿到種子資訊"). */
  private async onMetadata(a: Active): Promise<void> {
    if (a.hasMetadata) return;
    a.hasMetadata = true;
    const files = a.t.files;
    const dir = this.torrentDir(a.hash);
    if (!pathsAreSafe(dir, files, resolve, sep)) {
      this.log.warn({ torrent: a.id, security: true }, 'torrent has a file path outside its folder; stopped');
      return this.fail(a, 'UNSAFE_PATH', 'a file path leaves the download folder');
    }
    const row = await one<{ size_bytes: number; length_bytes: number | null; preview_reserve_bytes: number }>(
      this.pool,
      'select size_bytes, length_bytes, preview_reserve_bytes from torrents where id = $1',
      [a.id],
    );
    if (!row) return;
    const counted = Math.max(row.size_bytes, row.length_bytes ?? 0);
    const extra = a.t.length - counted;
    if (extra > SIZE_SLACK_BYTES) {
      const ok = await tx(this.pool, async (c) => {
        try {
          await admit(c, this.disk, this.config.storageReserveBytes, { bytes: extra, previewBytes: 0 });
        } catch {
          return false;
        }
        await c.query('update torrents set length_bytes = $2 where id = $1', [a.id, a.t.length]);
        return true;
      });
      if (!ok) {
        await this.pool.query('update torrents set length_bytes = $2 where id = $1', [a.id, a.t.length]);
        return this.fail(a, 'SIZE_MISMATCH', `torrent is ${a.t.length} bytes, ${extra} more than admitted`);
      }
    } else {
      await this.pool.query('update torrents set length_bytes = $2 where id = $1', [a.id, a.t.length]);
    }
    if (!mainVideo(files)) return this.fail(a, 'NO_VIDEO_FILE', 'no video file in the torrent');
    await this.pool.query(`update torrents set phase = 'data' where id = $1 and state = 'downloading'`, [a.id]);
    await this.wake(a.id);
  }

  private async progress(a: Active, stallMinutes: number): Promise<void> {
    if (a.busy) return;
    const t = a.t;
    const r = await this.pool.query(
      `update torrents set progress = $2, downloaded_bytes = $3, uploaded_bytes = $4, download_bps = $5, peers = $6,
              last_progress_at = to_timestamp($7 / 1000.0), phase = case when phase = 'verifying' and $8 then 'data' else phase end
        where id = $1 and state = 'downloading'`,
      [
        a.id,
        Math.min(1, t.progress),
        Math.round(t.downloaded),
        Math.round(t.uploaded),
        Math.round(t.downloadSpeed),
        t.numPeers,
        a.lastProgressAt,
        t.ready,
      ],
    );
    if (r.rowCount) await this.wake(a.id, false);
    const s = stalled(this.now(), a.startedAt, a.lastProgressAt, a.hasMetadata || t.ready, stallMinutes);
    if (s)
      await this.fail(a, s, s === 'STALLED' ? `no data for ${stallMinutes} minutes` : 'no metadata after 5 minutes');
  }

  private async seedProgress(id: string, t: EngineTorrent, mode: 'stop' | 'ratio'): Promise<void> {
    await this.pool.query('update torrents set uploaded_bytes = $2 where id = $1', [id, Math.round(t.uploaded)]);
    if (mode === 'stop' || t.uploaded >= t.length) {
      this.seeding.delete(id);
      await t.stop();
      await this.pool.query('update torrents set seeding = false where id = $1', [id]);
    }
  }

  /** A real pause: remember the pieces, leave the client, keep the files (docs/06, "暫停"). */
  private async pause(id: string): Promise<void> {
    const a = this.active.get(id);
    if (!a) {
      await this.pool.query(
        `update torrents set state = 'paused', download_bps = 0, peers = 0 where id = $1 and state = 'downloading' and want = 'pause'`,
        [id],
      );
      return this.wake(id);
    }
    a.busy = true;
    const bitfield = a.t.bitfield();
    this.active.delete(id);
    await a.t.stop();
    await this.pool.query(
      `update torrents set state = 'paused', clean_stop = true, bitfield = $2, download_bps = 0, peers = 0
        where id = $1 and state = 'downloading' and want = 'pause'`,
      [id, bitfield],
    );
    await this.wake(id);
  }

  /** Every kind of failure ends the same way, and none of them deletes anything (docs/06, "失敗時的收尾"). */
  private async fail(a: Active, code: string, message: string): Promise<void> {
    if (a.busy) return;
    a.busy = true;
    const bitfield = a.hasMetadata ? a.t.bitfield() : null;
    this.active.delete(a.id);
    await a.t.stop();
    await this.markFailed(a.id, bitfield, code, message);
  }

  private async markFailed(id: string, bitfield: Buffer | null, code: string, message: string): Promise<void> {
    const disk = await one<{ info_hash: string }>(this.pool, 'select info_hash from torrents where id = $1', [id]);
    const bytes = disk ? await folderBytes(this.torrentDir(disk.info_hash)) : 0;
    const notes = await tx(this.pool, async (c) => {
      const r = await c.query(
        `update torrents set state = 'failed', error_code = $2, error_message = $3, clean_stop = true, bitfield = coalesce($4, bitfield),
                disk_bytes = $5, download_bps = 0, peers = 0, phase = null
          where id = $1 and state = 'downloading' and want <> 'remove'`,
        [id, code, message.slice(0, 500), bitfield, bytes],
      );
      if (!r.rowCount) return [];
      return this.notifyHolders(c, id, 'download.failed', { errorCode: code }, { page: 'downloads' });
    });
    this.log.warn({ torrent: id, code }, 'download failed');
    await this.wake(id, true, notes);
  }

  /** Finished (docs/06, "完成"). The preview plan frozen at admission moves to media_files (D40). */
  private async complete(a: Active): Promise<void> {
    if (a.busy) return;
    a.busy = true;
    const settings = await readSettings(this.pool);
    this.active.delete(a.id);
    const files = a.t.files;
    if (settings.downloads.seedMode === 'ratio') this.seeding.set(a.id, a.t);
    else await a.t.stop();
    const main = mainVideo(files);
    const bytes = await folderBytes(this.torrentDir(a.hash));
    const notes = await tx(this.pool, async (c) => {
      const t = await one<{
        preview_reserve_bytes: number;
        preview_proxy_res: string | null;
        video_codec: string;
        bit_depth: number;
      }>(
        c,
        `update torrents set state = 'completed', progress = 1, disk_bytes = $2, completed_at = now(), bitfield = null, download_bps = 0,
                peers = 0, phase = null, seeding = $3, downloaded_bytes = greatest(downloaded_bytes, coalesce(length_bytes, size_bytes))
          where id = $1 and state = 'downloading' and want <> 'remove'
          returning preview_reserve_bytes, preview_proxy_res, video_codec, bit_depth`,
        [a.id, bytes, settings.downloads.seedMode === 'ratio'],
      );
      if (!t) return null;
      // Analysis waits for the media service when automatic analysis is on, otherwise for someone to
      // open the film. The preview plan frozen at admission moves over unchanged (D40).
      await c.query(
        `insert into media_files (torrent_id, rel_path, size_bytes, direct_play, analysis_state, audio_state, proxy_state, proxy_res, reserve_bytes)
         values ($1, $2, $3, $4, $9, $5, $6, $7, $8)`,
        [
          a.id,
          main?.path ?? '',
          main?.length ?? 0,
          predictDirectPlay(t.video_codec, t.bit_depth),
          t.preview_reserve_bytes > 0 ? 'pending' : 'none',
          t.preview_proxy_res ? 'pending' : 'none',
          t.preview_proxy_res,
          t.preview_reserve_bytes,
          settings.media.analyzeAuto ? 'pending' : 'none',
        ],
      );
      await c.query('update torrents set preview_reserve_bytes = 0 where id = $1', [a.id]);
      return this.notifyHolders(
        c,
        a.id,
        'download.completed',
        {},
        { page: 'workspace', torrentId: a.id, tab: 'subtitles' },
      );
    });
    if (notes === null) return; // removed while finishing: the removal deletes everything
    this.log.info({ torrent: a.id }, 'download completed');
    await this.pool.query(`select pg_notify('paiban_media', '{}')`);
    await this.wake(a.id, true, notes);
  }

  private async notifyHolders(
    c: Pick<Pool, 'query'>,
    id: string,
    kind: string,
    data: object,
    link: object,
  ): Promise<number[]> {
    const r = await c.query<{ id: number }>(
      `insert into notifications (user_id, kind, data, link)
       select h.user_id, $2, jsonb_build_object('movieTitle', m.title, 'version', $3::text) || $4::jsonb, $5::jsonb
         from torrent_holders h join torrents t on t.id = h.torrent_id join movies m on m.id = t.movie_id
        where h.torrent_id = $1 returning id`,
      [id, kind, await this.versionOf(c, id), data, link],
    );
    return r.rows.map((x) => x.id);
  }

  private async versionOf(c: Pick<Pool, 'query'>, id: string): Promise<string> {
    const r = await one<{ quality: string; source_type: string; video_codec: string }>(
      c,
      'select quality, source_type, video_codec from torrents where id = $1',
      [id],
    );
    return r ? versionLabel(r) : '';
  }

  /** docs/03-data-model.md, "刪除一個下載時發生的事". Re-runnable after a crash. */
  private async remove(r: Row): Promise<void> {
    const a = this.active.get(r.id);
    if (a) {
      a.busy = true;
      this.active.delete(r.id);
    }
    this.seeding.delete(r.id);
    const ids = await one<{ media: string[]; subs: string[]; cands: string[] }>(
      this.pool,
      `select coalesce((select array_agg(id::text) from media_files where torrent_id = $1), '{}') as media,
              coalesce((select array_agg(id::text) from subtitles where torrent_id = $1), '{}') as subs,
              coalesce((select array_agg(id::text) from subtitle_candidates where torrent_id = $1), '{}') as cands`,
      [r.id],
    );
    await removeDownloadFiles(
      this.config.dataDir,
      this.engine,
      {
        infoHash: r.info_hash,
        mediaIds: ids?.media ?? [],
        subtitleIds: ids?.subs ?? [],
        candidateIds: ids?.cands ?? [],
      },
      this.log,
    );
    const out = await tx(this.pool, async (c) => {
      const failedExports = await many<{
        id: string;
        created_by: string | null;
        movie_title: string;
        file_name: string;
      }>(
        c,
        `update exports set state = 'failed', error_code = 'SOURCE_MISSING', reserved_bytes = 0, progress = 0
          where torrent_id = $1 and state in ('queued', 'running') returning id, created_by, movie_title, file_name`,
        [r.id],
      );
      const exportNotes: number[] = [];
      for (const e of failedExports)
        if (e.created_by) {
          const n = await one<{ id: number }>(
            c,
            `insert into notifications (user_id, kind, data, link)
             values ($1, 'export.failed', jsonb_build_object('movieTitle', $2::text, 'fileName', $3::text, 'errorCode', 'SOURCE_MISSING'), null) returning id`,
            [e.created_by, e.movie_title, e.file_name],
          );
          if (n) exportNotes.push(n.id);
        }
      // Their tasks failed with them (docs/03-data-model.md, step 4); the film's other tasks are cancelled.
      const failedTasks = await many<{ id: string }>(
        c,
        `update tasks set state = 'failed', error_code = 'SOURCE_MISSING', finished_at = now()
          where kind = 'export' and input->>'exportId' = any($1::text[]) and state in ('queued', 'running') returning id`,
        [failedExports.map((e) => e.id)],
      );
      const cancelledTasks = await many<{ id: string }>(
        c,
        `update tasks set state = 'cancelled', finished_at = now() where torrent_id = $1 and state in ('queued', 'running') returning id`,
        [r.id],
      );
      const gone = await one<{ movie_id: string }>(
        c,
        `delete from torrents where id = $1 and want = 'remove' returning movie_id`,
        [r.id],
      );
      let ytsId: number | null = null;
      if (gone) {
        const m = await one<{ yts_id: number }>(
          c,
          `delete from movies where id = $1 and not exists (select 1 from torrents where movie_id = $1) returning yts_id`,
          [gone.movie_id],
        );
        ytsId = m?.yts_id ?? null;
      }
      return {
        notes: exportNotes,
        ytsId,
        deleted: !!gone,
        exports: failedExports.map((e) => e.id),
        tasks: [...failedTasks, ...cancelledTasks].map((t) => t.id),
      };
    });
    if (out.ytsId !== null) await removePoster(this.config.dataDir, out.ytsId);
    // The subtitle tracks of the exports that just failed: a running mux job removes them too when it
    // notices, but one still waiting has nobody else to do it.
    for (const e of out.exports) await removeExportTracks(this.config.dataDir, e);
    if (out.deleted) {
      await this.pool.query(`select pg_notify('paiban_events', $1)`, [
        JSON.stringify({ type: 'torrent.removed', id: r.id }),
      ]);
      await this.pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
      for (const e of out.exports)
        await this.pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'export', id: e })]);
      for (const t of out.tasks)
        await this.pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'task', id: t })]);
      for (const n of out.notes)
        await this.pool.query(`select pg_notify('paiban_events', $1)`, [
          JSON.stringify({ type: 'notification', id: String(n) }),
        ]);
    }
  }

  /** Tells the api something changed: the torrent, and the usage when bytes moved. */
  private async wake(id: string, usage = false, notifications: number[] = []): Promise<void> {
    await this.pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'torrent', id })]);
    if (usage) await this.pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
    for (const n of notifications)
      await this.pool.query(`select pg_notify('paiban_events', $1)`, [
        JSON.stringify({ type: 'notification', id: String(n) }),
      ]);
  }

  /** SIGTERM (docs/06, "重啟"): save every bitfield, mark clean stops, leave state 'downloading'. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    await this.chain;
    for (const a of [...this.active.values()]) {
      const bitfield = a.t.bitfield();
      await a.t.stop();
      await this.pool.query(
        `update torrents set clean_stop = true, bitfield = coalesce($2, bitfield), download_bps = 0, peers = 0 where id = $1`,
        [a.id, bitfield],
      );
    }
    this.active.clear();
    await this.engine.destroy();
  }

  get activeCount(): number {
    return this.active.size;
  }
}
