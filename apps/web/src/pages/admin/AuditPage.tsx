import type { AdminUser, AuditEntry } from '@paiban/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { Banner, PageHead, Skeleton } from '../../components/Bits';
import { t } from '../../copy/zh-TW';
import { get } from '../../lib/api';
import { bytes } from '../../lib/format';

/** docs/11-pages.md, "操作紀錄": time, who (as named then), action and target, 50 per page. */
export function AuditPage() {
  const [params, setParams] = useSearchParams();
  const userId = params.get('user') ?? '';
  const users = useQuery({ queryKey: ['admin', 'users'], queryFn: () => get<AdminUser[]>('/api/admin/users') });
  const log = useInfiniteQuery({
    queryKey: ['admin', 'audit', userId],
    queryFn: ({ pageParam }) =>
      get<{ items: AuditEntry[]; nextBefore: number | null }>(
        `/api/admin/audit?${new URLSearchParams({ ...(userId ? { userId } : {}), ...(pageParam ? { before: String(pageParam) } : {}) })}`,
      ),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHead title={t.audit.title} lead={t.audit.lead}>
        <label className="sel-l">
          <span>{t.audit.user}</span>
          <select value={userId} onChange={(e) => setParams(e.target.value ? { user: e.target.value } : {})}>
            <option value="">{t.audit.everyone}</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        </label>
      </PageHead>
      <section className="card">
        {log.isError ? (
          <Banner tone="bad">{t.common.unknownError}</Banner>
        ) : !log.data ? (
          <Skeleton lines={5} />
        ) : items.length === 0 ? (
          <p className="sub">{userId ? t.audit.emptyFor : t.audit.empty}</p>
        ) : (
          <div className="tw">
            <table className="rtable">
              <thead>
                <tr>
                  <th>{t.audit.cols.at}</th>
                  <th>{t.audit.cols.user}</th>
                  <th>{t.audit.cols.action}</th>
                  <th>{t.audit.cols.target}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id}>
                    <td className="sub mono lead">{when(e.at)}</td>
                    <td data-label={t.audit.cols.user}>{e.actorName || e.actor?.displayName || '—'}</td>
                    <td data-label={t.audit.cols.action}>{actionText(e)}</td>
                    <td data-label={t.audit.cols.target}>{targetText(e)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {log.hasNextPage && (
          <button type="button" disabled={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>
            {t.audit.older}
          </button>
        )}
      </section>
    </>
  );
}

/** "今天 09:14", "昨天 22:41", else the date with the time (docs/17-ui.md). */
export function when(iso: string): string {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = (day(new Date()) - day(d)) / 86_400_000;
  if (diff === 0) return t.audit.today(hm);
  if (diff === 1) return t.audit.yesterday(hm);
  return `${d.toLocaleDateString('zh-TW')} ${hm}`;
}

export function actionText(e: AuditEntry): string {
  if (e.action === 'admin.settings.change') {
    const keys = String(e.target.keys ?? '').split(',');
    const s = t.audit.settings;
    if (keys.some((k) => k.startsWith('downloads.') || k.startsWith('media.'))) return s.downloads;
    if (keys.includes('yts.baseUrl')) return s.yts;
    if (keys.includes('providers.yify.baseUrl')) return s.yify;
    if (keys.includes('providers.justsubtitles.mode')) return s.jsMode;
    if (keys.includes('providers.cacheHours')) return s.cache;
    return s.other;
  }
  return t.audit.actions[e.action] ?? e.action;
}

export function targetText(e: AuditEntry): string {
  const x = e.target;
  const join = (...p: unknown[]) => p.filter((v) => v !== undefined && v !== '').join(' · ');
  if (e.action === 'admin.storage.delete')
    return join(t.itemKinds[String(x.itemKind)] ?? x.itemKind, x.fileName ?? x.movieTitle);
  if (x.movieTitle !== undefined) return join(x.movieTitle, x.version ?? x.language ?? x.releaseName ?? x.fileName);
  if (e.action === 'auth.login' || e.action === 'auth.session.revoke')
    return x.os || x.browser ? join(x.os, x.browser) : t.profile.unknownDevice;
  if (e.action === 'admin.user.role') return `${x.name} → ${t.shell.role[x.role as 'admin' | 'member'] ?? x.role}`;
  if (e.action === 'admin.invite.create')
    return join(t.shell.role[x.role as 'admin' | 'member'], t.users.daysOption(Number(x.days)));
  if (e.action === 'admin.storage.limit') return `${bytes(Number(x.fromBytes))} → ${bytes(Number(x.toBytes))}`;
  return join(x.name, x.code, x.fileName);
}
