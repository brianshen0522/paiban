import type { Export, LibraryItem, Notification, ServerEvent, Torrent, Workspace } from '@paiban/shared';
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
        if (!first) {
          void qc.invalidateQueries();
          window.dispatchEvent(new Event(RECONNECTED));
        }
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

/** The workbench listens for these itself: it decides whether a newer document may replace the open one. */
export const SUBTITLE_EVENT = 'paiban:subtitle';
export const RECONNECTED = 'paiban:reconnected';
export type SubtitleEvent = Extract<ServerEvent, { type: 'subtitle' }>;

function upsert<T extends { id: string }>(list: T[] | undefined, x: T, append = true): T[] | undefined {
  if (!list) return list;
  const i = list.findIndex((y) => y.id === x.id);
  if (i < 0) return append ? [...list, x] : list;
  const next = list.slice();
  next[i] = x;
  return next;
}

export function apply(qc: QueryClient, e: ServerEvent, onNotification: (n: Notification) => void): void {
  switch (e.type) {
    case 'torrent': {
      const t = e.torrent;
      const before =
        qc.getQueryData<Torrent[]>(keys.torrents('mine'))?.find((x) => x.id === t.id) ??
        qc.getQueryData<Workspace>(keys.workspace(t.id))?.item.torrent;
      qc.setQueryData<Torrent[]>(keys.torrents('mine'), (l) => upsert(l, t));
      qc.setQueryData<Torrent[]>(keys.torrents('all'), (l) => upsert(l, t));
      // Analysis and preview progress travel inside the torrent (Torrent.media).
      qc.setQueryData<LibraryItem[]>(keys.library, (l) =>
        l?.map((i) => (i.torrent.id === t.id ? { ...i, torrent: t } : i)),
      );
      qc.setQueryData<Workspace>(keys.workspace(t.id), (w) => (w ? { ...w, item: { ...w.item, torrent: t } } : w));
      if (t.media) {
        qc.setQueryData(keys.media(t.media.id), t.media);
        // The waveform and speech appear once the analysis has ended.
        if (
          before?.media?.analysis !== t.media.analysis &&
          (t.media.analysis === 'ready' || t.media.analysis === 'failed')
        )
          void qc.invalidateQueries({ queryKey: ['media', t.media.id] });
      }
      // A status change matters to the film page and the library; progress ticks do not.
      if (!before || before.status !== t.status || before.holders.length !== t.holders.length) {
        void qc.invalidateQueries({ queryKey: ['movie'] });
        void qc.invalidateQueries({ queryKey: keys.library });
        void qc.invalidateQueries({ queryKey: keys.storage });
        void qc.invalidateQueries({ queryKey: keys.workspace(t.id) });
      }
      break;
    }
    case 'torrent.removed':
      for (const scope of ['mine', 'all'] as const)
        qc.setQueryData<Torrent[]>(keys.torrents(scope), (l) => l?.filter((x) => x.id !== e.id));
      void qc.invalidateQueries({ queryKey: keys.library });
      void qc.invalidateQueries({ queryKey: ['movie'] });
      void qc.invalidateQueries({ queryKey: keys.workspace(e.id) });
      break;
    case 'candidates':
      void qc.invalidateQueries({ queryKey: keys.candidates(e.torrentId) });
      break;
    case 'subtitle':
      void qc.invalidateQueries({ queryKey: keys.workspace(e.torrentId) });
      void qc.invalidateQueries({ queryKey: keys.library });
      if (e.removed) void qc.invalidateQueries({ queryKey: keys.candidates(e.torrentId) });
      window.dispatchEvent(new CustomEvent<SubtitleEvent>(SUBTITLE_EVENT, { detail: e }));
      break;
    case 'export': {
      const x: Export = e.export;
      const before = x.torrentId
        ? qc.getQueryData<Workspace>(keys.workspace(x.torrentId))?.exports.find((y) => y.id === x.id)
        : undefined;
      if (x.torrentId)
        qc.setQueryData<Workspace>(keys.workspace(x.torrentId), (w) =>
          w ? { ...w, exports: upsert(w.exports, x, false) ?? w.exports } : w,
        );
      qc.setQueryData<Export[]>(keys.exports, (l) => upsert(l, x, false));
      if (!before || before.state !== x.state) {
        if (x.torrentId) void qc.invalidateQueries({ queryKey: keys.workspace(x.torrentId) });
        void qc.invalidateQueries({ queryKey: keys.exports });
        void qc.invalidateQueries({ queryKey: keys.library });
      }
      break;
    }
    case 'export.removed':
      qc.setQueriesData<Workspace>({ queryKey: ['workspace'] }, (w) =>
        w ? { ...w, exports: w.exports.filter((x) => x.id !== e.id) } : w,
      );
      qc.setQueryData<Export[]>(keys.exports, (l) => l?.filter((x) => x.id !== e.id));
      void qc.invalidateQueries({ queryKey: keys.library });
      break;
    case 'usage':
      qc.setQueryData<StorageView>(keys.storage, (s) => (s ? { ...s, usage: e.usage } : s));
      qc.setQueriesData<Workspace>({ queryKey: ['workspace'] }, (w) => (w ? { ...w, usage: e.usage } : w));
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
