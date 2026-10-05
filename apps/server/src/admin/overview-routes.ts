import type { AdminOverview, AuditEntry, ProblemCode, SourceHealth } from '@paiban/shared';
import { USAGE_WARN_FREE_BYTES } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { many, one } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { requireAdmin } from '../http/guards.js';
import { readSourceHealth } from '../settings/health.js';
import { readSettings } from '../settings/settings.js';
import { diskInfo, readUsage } from '../storage/usage.js';
import { versionLabel } from '../torrents/view.js';

type Problem = AdminOverview['problems'][number];

/** A service that has not reported for this long is shown as not responding (docs/02-architecture.md). */
const SERVICE_SILENCE_MS = 30_000;

/**
 * The administrator's front page (docs/11-pages.md, "總覽"): four tiles, everything that needs
 * attention, the sources and the latest activity. Sentences are written by the web app.
 */
export function overviewRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  app.get('/api/admin/overview', async (req): Promise<AdminOverview> => {
    requireAdmin(req);
    const [usage, settings, disk, health] = await Promise.all([
      readUsage(pool),
      readSettings(pool),
      diskInfo(pool, deps.disk, config.storageReserveBytes),
      readSourceHealth(pool),
    ]);
    const counts = await one<{
      active: number;
      queued: number;
      users: number;
      disabled: number;
      invites: number;
      running: number;
      no_holders: number;
      orphans: number;
      orphan_bytes: number;
      missing: number;
    }>(
      pool,
      `select (select count(*)::int from torrents where state = 'downloading' and want <> 'remove') as active,
              (select count(*)::int from torrents where state = 'queued' and want = 'run') as queued,
              (select count(*)::int from users where not disabled) as users,
              (select count(*)::int from users where disabled) as disabled,
              (select count(*)::int from invites where used_at is null and expires_at > now()) as invites,
              (select count(*)::int from tasks where state = 'running') as running,
              (select count(*)::int from torrents t where t.want <> 'remove'
                  and not exists (select 1 from torrent_holders h where h.torrent_id = t.id)) as no_holders,
              (select count(*)::int from storage_findings where kind = 'orphan') as orphans,
              (select coalesce(sum(bytes), 0) from storage_findings where kind = 'orphan') as orphan_bytes,
              (select count(*)::int from storage_findings where kind = 'missing') as missing`,
    );
    const c = counts ?? {
      active: 0,
      queued: 0,
      users: 0,
      disabled: 0,
      invites: 0,
      running: 0,
      no_holders: 0,
      orphans: 0,
      orphan_bytes: 0,
      missing: 0,
    };

    const problems: Problem[] = [];
    const add = (
      level: 'bad' | 'warn',
      code: ProblemCode,
      page: Problem['page'],
      data: Record<string, string | number> = {},
    ) => problems.push({ level, code, data, page });

    if (usage.over) add('bad', 'OVER_LIMIT', 'storage');
    else if (usage.freeBytes < USAGE_WARN_FREE_BYTES)
      add('warn', 'NEARLY_FULL', 'storage', { freeBytes: usage.freeBytes });
    // The disk itself, not the limit: below twice the space the app always leaves free.
    if (disk.availableBytes < 2 * disk.reserveBytes)
      add('bad', 'DISK_LOW', 'storage', { availableBytes: disk.availableBytes });

    const failed = await many<{
      title: string;
      quality: string;
      source_type: string;
      video_codec: string;
      error_code: string | null;
      disk_bytes: number;
      req_name: string | null;
    }>(
      pool,
      `select m.title, t.quality, t.source_type, t.video_codec, t.error_code, t.disk_bytes, u.display_name as req_name
         from torrents t join movies m on m.id = t.movie_id left join users u on u.id = t.requested_by
        where t.state = 'failed' and t.want <> 'remove' order by t.queued_at`,
    );
    for (const f of failed)
      add('bad', 'FAILED_DOWNLOAD', 'downloads', {
        movieTitle: f.title,
        version: versionLabel(f),
        requestedBy: f.req_name ?? '',
        errorCode: f.error_code ?? '',
        bytes: f.disk_bytes,
      });

    const yts = health.find((h) => h.id === 'yts');
    if (!settings.yts.baseUrl) add('bad', 'YTS_NOT_CONFIGURED', 'sources');
    else if (yts?.state === 'down') add('bad', 'YTS_DOWN', 'sources');
    for (const h of health)
      if (h.id !== 'yts' && (h.state === 'down' || h.state === 'warn'))
        add(h.state === 'down' ? 'bad' : 'warn', 'SOURCE_DOWN', 'sources', { source: h.id, code: h.code ?? '' });

    // Analysis or preview assets failing right now (not past failures that were retried).
    const assets = await many<{
      title: string;
      analysis_state: string;
      audio_state: string;
      proxy_state: string;
      error: { code?: string } | null;
    }>(
      pool,
      `select m.title, mf.analysis_state, mf.audio_state, mf.proxy_state, mf.error
         from media_files mf join torrents t on t.id = mf.torrent_id join movies m on m.id = t.movie_id
        where t.want <> 'remove' and 'failed' in (mf.analysis_state, mf.audio_state, mf.proxy_state)`,
    );
    for (const a of assets) {
      if (a.analysis_state === 'failed')
        add('warn', 'FAILED_TASK', 'system', { kind: 'analyze', movieTitle: a.title, errorCode: a.error?.code ?? '' });
      if (a.audio_state === 'failed' || a.proxy_state === 'failed')
        add('warn', 'FAILED_TASK', 'system', { kind: 'preview', movieTitle: a.title, errorCode: a.error?.code ?? '' });
    }

    const beats = await many<{ service: string; silent_ms: number }>(
      pool,
      `select service, extract(epoch from (now() - last_seen_at)) * 1000 as silent_ms from service_heartbeats`,
    );
    for (const s of ['torrent', 'media']) {
      const b = beats.find((x) => x.service === s);
      if (!b || b.silent_ms > SERVICE_SILENCE_MS) add('bad', 'SERVICE_DOWN', 'system', { service: s });
    }
    if (c.missing > 0) add('warn', 'MISSING_FILES', 'storage', { count: c.missing });
    if (c.orphans > 0) add('warn', 'ORPHANS', 'storage', { count: c.orphans, bytes: c.orphan_bytes });
    if (c.no_holders > 0) add('warn', 'NO_HOLDERS', 'storage', { count: c.no_holders });
    problems.sort((a, b) => (a.level === b.level ? 0 : a.level === 'bad' ? -1 : 1));

    const sources: SourceHealth[] = [
      yts ?? { id: 'yts', state: settings.yts.baseUrl ? 'ok' : 'off', checkedAt: null, code: null, data: {} },
    ];
    const recent = await many<{
      id: number;
      at: Date;
      actor_id: string | null;
      actor_now: string | null;
      actor_name: string;
      action: string;
      target: Record<string, string | number>;
    }>(
      pool,
      `select a.id, a.at, a.actor_id, u.display_name as actor_now, a.actor_name, a.action, a.target
         from audit_log a left join users u on u.id = a.actor_id order by a.id desc limit 6`,
    );
    return {
      usage,
      downloads: { active: c.active, maxActive: settings.downloads.maxActive, queued: c.queued },
      users: { active: c.users, disabled: c.disabled, openInvites: c.invites },
      tasks: { running: c.running, current: null },
      problems,
      sources,
      recent: recent.map(
        (r): AuditEntry => ({
          id: r.id,
          at: r.at.toISOString(),
          actor: r.actor_id ? { id: r.actor_id, displayName: r.actor_now ?? r.actor_name } : null,
          actorName: r.actor_name,
          action: r.action,
          target: r.target,
        }),
      ),
    };
  });
}
