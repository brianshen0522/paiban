import pg from 'pg';
import type { Logger } from 'pino';
import type { Pool } from '../db/pool.js';
import { publishExport } from '../exports/view.js';
import type { EventHub } from './hub.js';
import { publishCandidates, publishNotification, publishTorrent, publishUsage } from './publish.js';

/**
 * LISTEN paiban_events on a dedicated connection (not one borrowed from the pool) and turn the
 * other services' {type, id} wake-ups into events (docs/04-api.md, "伺服器之間的通知").
 * Reconnects after a lost connection.
 */
export function listenForEvents(databaseUrl: string, pool: Pool, hub: EventHub, log: Logger): () => Promise<void> {
  let client: pg.Client | null = null;
  let stopped = false;

  const handle = async (payload: string | undefined) => {
    let msg: { type?: string; id?: string };
    try {
      msg = JSON.parse(payload ?? '{}');
    } catch {
      return;
    }
    try {
      if (msg.type === 'torrent' && msg.id) await publishTorrent(pool, hub, msg.id);
      else if (msg.type === 'torrent.removed' && msg.id) hub.toAll({ type: 'torrent.removed', id: msg.id });
      else if (msg.type === 'export' && msg.id) await publishExport(pool, hub, msg.id);
      else if (msg.type === 'export.removed' && msg.id) hub.toAll({ type: 'export.removed', id: msg.id });
      else if (msg.type === 'usage') await publishUsage(pool, hub);
      else if (msg.type === 'notification' && msg.id) await publishNotification(pool, hub, Number(msg.id));
      else if (msg.type === 'candidates' && msg.id) await publishCandidates(pool, hub, msg.id);
      else if (msg.type === 'task') {
        if (msg.id) hub.taskChanged(msg.id);
        hub.toAdmins({ type: 'admin', what: 'tasks' });
      } else if (msg.type === 'storage') {
        hub.toAdmins({ type: 'admin', what: 'storage' });
        await publishUsage(pool, hub);
      }
    } catch (err) {
      log.warn({ err, type: msg.type }, 'could not publish an event');
    }
  };

  const connect = async () => {
    while (!stopped) {
      try {
        client = new pg.Client({ connectionString: databaseUrl });
        client.on('notification', (n) => void handle(n.payload));
        client.on('error', (err) => {
          log.warn({ err }, 'event listener connection lost');
          client?.end().catch(() => undefined);
          client = null;
          if (!stopped) setTimeout(() => void connect(), 2000);
        });
        await client.connect();
        await client.query('listen paiban_events');
        return;
      } catch (err) {
        log.warn({ err }, 'event listener could not connect; retrying');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  void connect();

  return async () => {
    stopped = true;
    await client?.end().catch(() => undefined);
  };
}

/** Wakes another service. Payload is only {type, id}; the receiver reads the data itself. */
export async function notify(
  q: Pick<Pool, 'query'>,
  channel: 'paiban_torrent' | 'paiban_media' | 'paiban_events',
  payload: object = {},
): Promise<void> {
  await q.query('select pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
}
