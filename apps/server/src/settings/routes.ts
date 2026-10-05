import type { SettingsInfo, SourceCheck } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { many, one, tx } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin } from '../http/guards.js';
import { diskInfo } from '../storage/usage.js';
import { YtsClient } from '../yts/client.js';
import { readSourceHealth, recordSourceHealth } from './health.js';
import { readSettings, validatePatch, writeSettings } from './settings.js';

export async function settingsInfo(deps: Deps): Promise<SettingsInfo> {
  const names = new Set((await many<{ name: string }>(deps.pool, 'select name from secrets')).map((r) => r.name));
  const hb = await one<{ info: { lastIncomingAt?: string | null } }>(
    deps.pool,
    `select info from service_heartbeats where service = 'torrent'`,
  );
  const lastAt = hb?.info.lastIncomingAt ?? null;
  return {
    secrets: {
      tmdbKey: names.has('tmdbKey'),
      subdlKey: names.has('subdlKey'),
      assrtToken: names.has('assrtToken'),
      llmKey: names.has('llmKey'),
    },
    torrentPort: deps.config.torrentPort,
    torrentDhtPort: deps.config.torrentDhtPort,
    incoming: { seen: !!lastAt && Date.now() - Date.parse(lastAt) < 86_400_000, lastAt },
    disk: await diskInfo(deps.pool, deps.disk, deps.config.storageReserveBytes),
  };
}

/** The wording of admin.settings.change depends on which group changed (docs/12-auth.md). */
export function settingsGroup(keys: string[]): string {
  return keys.join(',');
}

export function settingsRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  const full = async () => ({
    settings: await readSettings(pool),
    info: await settingsInfo(deps),
    sources: await readSourceHealth(pool),
  });

  app.get('/api/admin/settings', async (req) => {
    requireAdmin(req);
    return full();
  });

  app.patch('/api/admin/settings', async (req) => {
    const user = requireAdmin(req);
    const current = await readSettings(pool);
    const leaves = await validatePatch(req.body, current, { allowLocal: config.allowLocalSources });
    if (leaves.length) {
      await tx(pool, async (c) => {
        await writeSettings(c, leaves, user.id);
        await audit(c, user, 'admin.settings.change', { keys: settingsGroup(leaves.map(([k]) => k)) }, req.ip);
      });
      // A different YTS address makes the old source health meaningless.
      if (leaves.some(([k]) => k === 'yts.baseUrl')) await pool.query(`delete from source_health where source = 'yts'`);
      await pool.query(`select pg_notify('paiban_torrent', '{}')`);
      deps.events.toAdmins({ type: 'admin', what: 'settings' });
    }
    return full();
  });

  app.post('/api/admin/sources/:id/test', async (req) => {
    requireAdmin(req);
    const { id } = parse(z.object({ id: z.enum(['yts']) }), req.params);
    const result = await testSource(deps, id);
    deps.events.toAdmins({ type: 'admin', what: 'sources' });
    return result;
  });
}

/** Tries a source once. Always a result, never an error of the endpoint (docs/13-settings.md). */
export async function testSource(deps: Deps, id: 'yts'): Promise<SourceCheck> {
  const started = Date.now();
  const done = async (
    ok: boolean,
    code: SourceCheck['code'],
    data: Record<string, string | number> = {},
  ): Promise<SourceCheck> => {
    await recordSourceHealth(
      deps.pool,
      id,
      ok ? 'ok' : code === 'NOT_CONFIGURED' || code === 'RATE_LIMITED' ? 'warn' : 'down',
      code,
      data,
    );
    return { ok, code, data, ms: Date.now() - started };
  };
  const { yts } = await readSettings(deps.pool);
  if (!yts.baseUrl) return done(false, 'NOT_CONFIGURED');
  const client = new YtsClient(deps.outbound, yts.baseUrl);
  try {
    const page = await client.search({ page: 1, limit: 1 });
    return done(true, 'OK', { status: 200, count: page.total });
  } catch (err) {
    if (err instanceof ApiError) {
      const redirect = /redirects to (\S+)/.exec(err.message);
      if (redirect?.[1]) return done(false, 'REDIRECTED', { host: redirect[1] });
      if (err.code === 'YTS_BAD_RESPONSE') return done(false, 'BAD_RESPONSE');
      const status = /answered (\d{3})/.exec(err.message);
      return done(false, 'UNREACHABLE', status?.[1] ? { status: Number(status[1]) } : {});
    }
    throw err;
  }
}
