import type { AdminUser, AuditEntry, Invite } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { newInviteCode, newResetToken, resetHash } from '../auth/account-routes.js';
import { prefsOf } from '../auth/users.js';
import { type Client, many, one, pgCode, tx, UNIQUE_VIOLATION } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin } from '../http/guards.js';
import { linkBase } from '../http/links.js';
import { readSettings } from '../settings/settings.js';

/** Administration of people (docs/04-api.md, "Admin"; docs/11-pages.md, "Users & invites (15)", "Activity log (21)"). */

type UserRow = {
  id: string;
  username: string;
  display_name: string;
  role: 'admin' | 'member';
  disabled: boolean;
  prefs: Record<string, unknown>;
  last_seen_at: Date | null;
  held: number;
  active: number;
  sole: number;
};

const USERS = `
select u.id, u.username, u.display_name, u.role, u.disabled, u.prefs, u.last_seen_at,
       (select count(*)::int from torrent_holders h join torrents t on t.id = h.torrent_id
         where h.user_id = u.id and t.state = 'completed' and t.want <> 'remove') as held,
       (select count(*)::int from torrent_holders h join torrents t on t.id = h.torrent_id
         where h.user_id = u.id and t.state in ('queued', 'downloading', 'paused') and t.want <> 'remove') as active,
       (select count(*)::int from torrent_holders h join torrents t on t.id = h.torrent_id
         where h.user_id = u.id and t.want <> 'remove'
           and not exists (select 1 from torrent_holders o where o.torrent_id = h.torrent_id and o.user_id <> u.id)) as sole
  from users u`;

/**
 * There must always be an enabled administrator. The rows are locked first, so two administrators
 * demoting each other at the same moment take turns and the second one is refused.
 */
async function assertAdminRemains(c: Client, changing: string): Promise<void> {
  await c.query(`select id from users where role = 'admin' for update`);
  const r = await one<{ n: number }>(
    c,
    `select count(*)::int as n from users where role = 'admin' and not disabled and id <> $1`,
    [changing],
  );
  if ((r?.n ?? 0) === 0) throw new ApiError('LAST_ADMIN', 'at least one enabled administrator must remain');
}

export function adminUserRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;
  const toUser = async (rows: UserRow[]): Promise<AdminUser[]> => {
    const { subtitles } = await readSettings(pool);
    return rows.map((r) => ({
      id: r.id,
      username: r.username,
      displayName: r.display_name,
      role: r.role,
      prefs: prefsOf(r.prefs, subtitles.defaultLangs),
      disabled: r.disabled,
      lastSeenAt: r.last_seen_at?.toISOString() ?? null,
      held: r.held,
      activeDownloads: r.active,
      soleHolderOf: r.sole,
    }));
  };
  const loadUser = async (id: string) => {
    const [u] = await toUser(await many<UserRow>(pool, `${USERS} where u.id = $1`, [id]));
    return u;
  };
  const IdParams = z.object({ id: z.uuid() });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req);
    return toUser(await many<UserRow>(pool, `${USERS} order by u.created_at`));
  });

  app.patch('/api/admin/users/:id', async (req) => {
    const me = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({ role: z.enum(['admin', 'member']).optional(), disabled: z.boolean().optional() }),
      req.body,
    );
    if (id === me.id)
      throw new ApiError('FORBIDDEN', 'administrators cannot change their own role or disable themselves');
    await tx(pool, async (c) => {
      const before = await one<{ display_name: string; role: string; disabled: boolean }>(
        c,
        'select display_name, role, disabled from users where id = $1 for update',
        [id],
      );
      if (!before) throw new ApiError('NOT_FOUND', 'no such user');
      const losesAdmin =
        before.role === 'admin' && !before.disabled && (body.role === 'member' || body.disabled === true);
      if (losesAdmin) await assertAdminRemains(c, id);
      if (body.role && body.role !== before.role) {
        await c.query('update users set role = $2 where id = $1', [id, body.role]);
        await audit(c, me, 'admin.user.role', { name: before.display_name, role: body.role }, req.ip);
      }
      if (body.disabled !== undefined && body.disabled !== before.disabled) {
        await c.query('update users set disabled = $2 where id = $1', [id, body.disabled]);
        // Disabling signs the person out everywhere at once (docs/12-auth.md).
        if (body.disabled) await c.query('delete from sessions where user_id = $1', [id]);
        await audit(
          c,
          me,
          body.disabled ? 'admin.user.disable' : 'admin.user.enable',
          { name: before.display_name },
          req.ip,
        );
      }
    });
    deps.events.toAdmins({ type: 'admin', what: 'users' });
    return loadUser(id);
  });

  /** A one-time link, 30 minutes. Shown only in this answer; older unused links stop working. */
  app.post('/api/admin/users/:id/reset-link', async (req) => {
    const me = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const token = newResetToken();
    const out = await tx(pool, async (c) => {
      const u = await one<{ display_name: string }>(c, 'select display_name from users where id = $1', [id]);
      if (!u) throw new ApiError('NOT_FOUND', 'no such user');
      await c.query('update password_resets set used_at = now() where user_id = $1 and used_at is null', [id]);
      const r = await one<{ expires_at: Date }>(
        c,
        `insert into password_resets (user_id, token_hash, created_by, expires_at) values ($1, $2, $3, now() + interval '30 minutes') returning expires_at`,
        [id, resetHash(token), me.id],
      );
      await audit(c, me, 'admin.user.reset_link', { name: u.display_name }, req.ip);
      return r?.expires_at ?? new Date();
    });
    return { url: `${linkBase(config.publicUrl, req)}/reset/${token}`, expiresAt: out.toISOString() };
  });

  /** Removes the account, never its files: what only they held stays, without holders (docs/10-storage.md). */
  app.delete('/api/admin/users/:id', async (req, reply) => {
    const me = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    if (id === me.id) throw new ApiError('FORBIDDEN', 'administrators cannot remove themselves');
    await tx(pool, async (c) => {
      const u = await one<{ display_name: string; role: string; disabled: boolean }>(
        c,
        'select display_name, role, disabled from users where id = $1 for update',
        [id],
      );
      if (!u) throw new ApiError('NOT_FOUND', 'no such user');
      if (u.role === 'admin' && !u.disabled) await assertAdminRemains(c, id);
      await c.query('delete from users where id = $1', [id]);
      await audit(c, me, 'admin.user.remove', { name: u.display_name }, req.ip);
    });
    deps.events.toAdmins({ type: 'admin', what: 'users' });
    return reply.status(204).send();
  });

  /* -------------------------------------------------------------- invites */

  const INVITES = `
select i.id, i.code, i.role, i.expires_at, i.used_at,
       cb.id as by_id, cb.display_name as by_name, ub.id as used_id, ub.display_name as used_name
  from invites i left join users cb on cb.id = i.created_by left join users ub on ub.id = i.used_by`;
  type InviteRow = {
    id: string;
    code: string;
    role: 'admin' | 'member';
    expires_at: Date;
    used_at: Date | null;
    by_id: string | null;
    by_name: string | null;
    used_id: string | null;
    used_name: string | null;
  };
  const toInvite = (r: InviteRow, base: string): Invite => ({
    id: r.id,
    code: r.code,
    url: `${base}/invite/${r.code}`,
    role: r.role,
    state: r.used_at ? 'used' : r.expires_at.getTime() <= Date.now() ? 'expired' : 'open',
    createdBy: r.by_id ? { id: r.by_id, displayName: r.by_name ?? '' } : null,
    expiresAt: r.expires_at.toISOString(),
    usedBy: r.used_id ? { id: r.used_id, displayName: r.used_name ?? '' } : null,
  });

  app.get('/api/admin/invites', async (req) => {
    requireAdmin(req);
    return (await many<InviteRow>(pool, `${INVITES} order by i.created_at desc`)).map((r) =>
      toInvite(r, linkBase(config.publicUrl, req)),
    );
  });

  app.post('/api/admin/invites', async (req, reply) => {
    const me = requireAdmin(req);
    const body = parse(
      z.object({ role: z.enum(['admin', 'member']), days: z.union([z.literal(1), z.literal(3), z.literal(7)]) }),
      req.body,
    );
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await one<{ id: string }>(
          pool,
          `insert into invites (code, role, created_by, expires_at) values ($1, $2, $3, now() + make_interval(days => $4)) returning id`,
          [newInviteCode(), body.role, me.id, body.days],
        );
        // The code itself is not logged: it can still be used (docs/12-auth.md).
        await audit(pool, me, 'admin.invite.create', { role: body.role, days: body.days }, req.ip);
        deps.events.toAdmins({ type: 'admin', what: 'users' });
        const [inv] = await many<InviteRow>(pool, `${INVITES} where i.id = $1`, [r?.id]);
        if (!inv) throw new Error('invite vanished');
        return reply.status(201).send(toInvite(inv, linkBase(config.publicUrl, req)));
      } catch (err) {
        if (pgCode(err) !== UNIQUE_VIOLATION || attempt > 3) throw err;
      }
    }
  });

  /** Revoke an open invite or clear a used/expired one: both delete the row. */
  app.delete('/api/admin/invites/:id', async (req, reply) => {
    const me = requireAdmin(req);
    const { id } = parse(IdParams, req.params);
    const r = await one<{ code: string; used_at: Date | null; expires_at: Date }>(
      pool,
      'delete from invites where id = $1 returning code, used_at, expires_at',
      [id],
    );
    if (!r) throw new ApiError('NOT_FOUND', 'no such invite');
    if (!r.used_at && r.expires_at.getTime() > Date.now())
      await audit(pool, me, 'admin.invite.revoke', { code: r.code }, req.ip);
    deps.events.toAdmins({ type: 'admin', what: 'users' });
    return reply.status(204).send();
  });

  /* -------------------------------------------------------------- activity log */

  app.get('/api/admin/audit', async (req) => {
    requireAdmin(req);
    const q = parse(
      z.object({ userId: z.uuid().optional(), before: z.coerce.number().int().positive().optional() }),
      req.query,
    );
    const rows = await many<{
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
         from audit_log a left join users u on u.id = a.actor_id
        where ($1::uuid is null or a.actor_id = $1) and ($2::bigint is null or a.id < $2)
        order by a.id desc limit 51`,
      [q.userId ?? null, q.before ?? null],
    );
    const items: AuditEntry[] = rows.slice(0, 50).map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actor: r.actor_id ? { id: r.actor_id, displayName: r.actor_now ?? r.actor_name } : null,
      actorName: r.actor_name,
      action: r.action,
      target: r.target,
    }));
    return { items, nextBefore: rows.length > 50 ? (items.at(-1)?.id ?? null) : null };
  });
}
