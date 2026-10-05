import type { Torrent } from '@paiban/shared';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { apply } from './events';
import { keys } from './queries';

const torrent = (over: Partial<Torrent>): Torrent =>
  ({ id: 't1', status: 'downloading', progress: 0.1, holders: [{ id: 'u', displayName: 'mei' }], ...over }) as Torrent;

describe('live events', () => {
  it('patch a download in place and drop a removed one', () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.torrents('mine'), [torrent({})]);
    apply(qc, { type: 'torrent', torrent: torrent({ progress: 0.5 }) }, vi.fn());
    expect(qc.getQueryData<Torrent[]>(keys.torrents('mine'))?.[0]?.progress).toBe(0.5);
    apply(qc, { type: 'torrent.removed', id: 't1' }, vi.fn());
    expect(qc.getQueryData<Torrent[]>(keys.torrents('mine'))).toEqual([]);
  });
  it('count a new notification as unread and hand it on', () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.notifications, { items: [], unread: 0 });
    const seen = vi.fn();
    const n = { id: 1, kind: 'download.completed', data: {}, link: null, createdAt: '', read: false } as const;
    apply(qc, { type: 'notification', notification: n }, seen);
    expect(qc.getQueryData<{ unread: number }>(keys.notifications)?.unread).toBe(1);
    expect(seen).toHaveBeenCalledWith(n);
  });
});
