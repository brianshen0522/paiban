import type { Notification, ServerEvent, Torrent } from '@paiban/shared';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { keys, type StorageView } from './queries';

/**
 * Live updates (docs/04-api.md, "即時更新"): events patch the caches; ones carrying only an id
 * invalidate. After a reconnect everything the page shows is refetched, nothing is replayed.
 */
export function useServerEvents(enabled: boolean, onNotification: (n: Notification) => void): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const connect = () => {
      source = new EventSource('/api/events');
      source.onopen = () => {
        if (!first) void qc.invalidateQueries();
        first = false;
      };
      source.onmessage = (m) => {
        try {
          apply(qc, JSON.parse(m.data) as ServerEvent, onNotification);
        } catch {
          // a malformed event is ignored; the next refetch catches up
        }
      };
      source.onerror = () => {
        source?.close();
        retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      clearTimeout(retry);
      source?.close();
    };
  }, [enabled, qc, onNotification]);
}

function upsert(list: Torrent[] | undefined, t: Torrent): Torrent[] | undefined {
  if (!list) return list;
  const i = list.findIndex((x) => x.id === t.id);
  if (i < 0) return [...list, t];
  const next = list.slice();
  next[i] = t;
  return next;
}

export function apply(qc: QueryClient, e: ServerEvent, onNotification: (n: Notification) => void): void {
  switch (e.type) {
    case 'torrent': {
      const before = qc.getQueryData<Torrent[]>(keys.torrents('mine'))?.find((x) => x.id === e.torrent.id);
      qc.setQueryData<Torrent[]>(keys.torrents('mine'), (l) => upsert(l, e.torrent));
      qc.setQueryData<Torrent[]>(keys.torrents('all'), (l) => upsert(l, e.torrent));
      // A status change matters to the film page and the library; progress ticks do not.
      if (!before || before.status !== e.torrent.status || before.holders.length !== e.torrent.holders.length) {
        void qc.invalidateQueries({ queryKey: ['movie'] });
        void qc.invalidateQueries({ queryKey: keys.library });
        void qc.invalidateQueries({ queryKey: keys.storage });
      }
      break;
    }
    case 'torrent.removed':
      for (const scope of ['mine', 'all'] as const)
        qc.setQueryData<Torrent[]>(keys.torrents(scope), (l) => l?.filter((x) => x.id !== e.id));
      void qc.invalidateQueries({ queryKey: keys.library });
      void qc.invalidateQueries({ queryKey: ['movie'] });
      break;
    case 'usage':
      qc.setQueryData<StorageView>(keys.storage, (s) => (s ? { ...s, usage: e.usage } : s));
      void qc.invalidateQueries({ queryKey: keys.storage });
      void qc.invalidateQueries({ queryKey: ['movie'] });
      break;
    case 'notification':
      qc.setQueryData<{ items: Notification[]; unread: number }>(keys.notifications, (n) =>
        n ? { items: [e.notification, ...n.items].slice(0, 50), unread: n.unread + (e.notification.read ? 0 : 1) } : n,
      );
      onNotification(e.notification);
      break;
    case 'admin':
      void qc.invalidateQueries({ queryKey: ['admin'] });
      break;
    default:
      break;
  }
}
