import type { Notification } from '@paiban/shared';
import type { Queryable } from '../db/pool.js';
import { one } from '../db/pool.js';
import { readUsage } from '../storage/usage.js';
import { selectTorrents, toTorrent } from '../torrents/view.js';
import type { EventHub } from './hub.js';

/**
 * Turns a change into events for the people allowed to see it. Torrent events are built per viewer
 * because `Torrent.mine` depends on who is looking.
 */
export async function publishTorrent(q: Queryable, hub: EventHub, torrentId: string): Promise<void> {
  const [row] = await selectTorrents(q, 't.id = $1', [torrentId]);
  if (!row) return;
  const online = hub.connectedUsers();
  for (const h of row.holders)
    if (online.has(h.id)) hub.toUser(h.id, { type: 'torrent', torrent: toTorrent(row, h.id) });
}

export async function publishUsage(q: Queryable, hub: EventHub): Promise<void> {
  if (hub.size === 0) return;
  hub.toAll({ type: 'usage', usage: await readUsage(q) });
}

export async function publishNotification(q: Queryable, hub: EventHub, id: number): Promise<void> {
  const r = await one<{ user_id: string; n: Notification }>(
    q,
    `select user_id, ${NOTIFICATION_JSON} as n from notifications where id = $1`,
    [id],
  );
  if (r) hub.toUser(r.user_id, { type: 'notification', notification: r.n });
}

export const NOTIFICATION_JSON = `json_build_object('id', id, 'kind', kind, 'data', data, 'link', link,
  'createdAt', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'read', read_at is not null)`;
