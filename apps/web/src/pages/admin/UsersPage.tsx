import type { AdminUser, Invite, Me } from '@paiban/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { useOutletContext } from 'react-router';
import { Banner, Chip, ConfirmInline, PageHead, Skeleton } from '../../components/Bits';
import { useToast } from '../../components/Toasts';
import { t } from '../../copy/zh-TW';
import { ApiFailure, del, get, patch, post } from '../../lib/api';
import { copyText } from '../../lib/clipboard';
import { dateTime, relative } from '../../lib/format';

const USERS = ['admin', 'users'] as const;
const INVITES = ['admin', 'invites'] as const;

/** docs/11-pages.md, "使用者與邀請". */
export function UsersPage() {
  const me = useOutletContext<Me>();
  const users = useQuery({ queryKey: USERS, queryFn: () => get<AdminUser[]>('/api/admin/users') });
  return (
    <>
      <PageHead title={t.users.title} lead={t.users.lead} />
      <section className="card">
        <h2>{t.users.users}</h2>
        {users.isError ? (
          <Banner tone="bad">{t.common.unknownError}</Banner>
        ) : !users.data ? (
          <Skeleton lines={3} />
        ) : (
          <div className="tw">
            <table className="rtable">
              <thead>
                <tr>
                  <th>{t.users.cols.user}</th>
                  <th>{t.users.cols.role}</th>
                  <th>{t.users.cols.status}</th>
                  <th>{t.users.cols.lastSeen}</th>
                  <th className="num">{t.users.cols.held}</th>
                  <th className="act" />
                </tr>
              </thead>
              <tbody>
                {users.data.map((u) => (
                  <UserRow key={u.id} u={u} self={u.id === me.user.id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="sub">{t.users.disabledNote}</p>
      </section>
      <Invites />
    </>
  );
}

function UserRow({ u, self }: { u: AdminUser; self: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'bad' | 'info'; text: string; link?: string } | null>(null);

  const act = async (fn: () => Promise<unknown>, after?: () => void) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      after?.();
      void qc.invalidateQueries({ queryKey: USERS });
    } catch (err) {
      setNote({
        tone: 'bad',
        text: err instanceof ApiFailure && err.code === 'LAST_ADMIN' ? t.users.lastAdmin : t.common.unknownError,
      });
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  };
  const resetLink = () =>
    act(async () => {
      const r = await post<{ url: string; expiresAt: string }>(`/api/admin/users/${u.id}/reset-link`);
      setNote({ tone: 'info', text: t.users.resetLink, link: r.url });
    });

  return (
    <>
      <tr>
        <td className="lead">
          <b>{u.displayName}</b> <span className="sub mono">{u.username}</span>
          {self && <span className="sub"> {t.users.you}</span>}
        </td>
        <td data-label={t.users.cols.role}>{t.shell.role[u.role]}</td>
        <td data-label={t.users.cols.status}>
          {u.disabled ? <Chip>{t.users.disabledState}</Chip> : <Chip tone="ok">{t.users.enabled}</Chip>}
        </td>
        <td className="sub" data-label={t.users.cols.lastSeen}>
          {u.lastSeenAt ? relative(u.lastSeenAt) : t.users.never}
        </td>
        <td className="num" data-label={t.users.cols.held}>
          {t.users.heldCount(u.held, u.activeDownloads)}
        </td>
        <td className="act">
          {self ? (
            <span className="sub">{t.users.selfNote}</span>
          ) : (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  act(() => patch(`/api/admin/users/${u.id}`, { role: u.role === 'admin' ? 'member' : 'admin' }))
                }
              >
                {u.role === 'admin' ? t.users.makeMember : t.users.makeAdmin}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => act(() => patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }))}
              >
                {u.disabled ? t.users.enable : t.users.disable}
              </button>
              <button type="button" disabled={busy} onClick={resetLink}>
                {t.users.resetPassword}
              </button>
              <button type="button" disabled={busy} aria-expanded={confirm} onClick={() => setConfirm(true)}>
                {t.users.remove}
              </button>
            </>
          )}
        </td>
      </tr>
      {(confirm || note) && (
        <tr className="blocked">
          <td colSpan={6}>
            {confirm && (
              <ConfirmInline
                text={t.users.confirmRemove(u.displayName, u.soleHolderOf)}
                confirmLabel={t.users.removeAccount}
                busy={busy}
                onConfirm={() =>
                  act(
                    () => del(`/api/admin/users/${u.id}`),
                    () => toast(t.users.removed),
                  )
                }
                onCancel={() => setConfirm(false)}
              />
            )}
            {note && (
              <Banner tone={note.tone} role={note.tone === 'info' ? 'status' : 'alert'}>
                <span>
                  {note.text}
                  {note.link && <span className="mono sel"> {note.link}</span>}
                </span>
                <div className="frow">
                  {note.link && (
                    <button
                      type="button"
                      onClick={async () =>
                        toast((await copyText(note.link ?? '')) ? t.users.copied : t.users.copyFailed)
                      }
                    >
                      {t.users.copy}
                    </button>
                  )}
                  <button type="button" onClick={() => setNote(null)}>
                    {t.common.close}
                  </button>
                </div>
              </Banner>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function Invites() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: INVITES, queryFn: () => get<Invite[]>('/api/admin/invites') });
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [days, setDays] = useState<1 | 3 | 7>(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(false);
    try {
      const inv = await post<Invite>('/api/admin/invites', { role, days });
      const copied = await copyText(inv.url);
      toast(copied ? `${t.users.inviteCreated}${t.users.copied}` : t.users.inviteCreated);
      void qc.invalidateQueries({ queryKey: INVITES });
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (id: string) => {
    await del(`/api/admin/invites/${id}`);
    void qc.invalidateQueries({ queryKey: INVITES });
  };

  return (
    <section className="card">
      <h2>{t.users.invites}</h2>
      <form className="frow" onSubmit={create}>
        <label className="sel-l">
          <span>{t.users.role}</span>
          <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
            <option value="member">{t.shell.role.member}</option>
            <option value="admin">{t.shell.role.admin}</option>
          </select>
        </label>
        <label className="sel-l">
          <span>{t.users.days}</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value) as 1 | 3 | 7)}>
            {([1, 3, 7] as const).map((d) => (
              <option key={d} value={d}>
                {t.users.daysOption(d)}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary" disabled={busy}>
          {t.users.createInvite}
        </button>
      </form>
      {error && <Banner tone="bad">{t.common.unknownError}</Banner>}
      {!list.data ? (
        <Skeleton lines={2} />
      ) : list.data.length === 0 ? (
        <p className="sub">{t.users.noInvites}</p>
      ) : (
        <div className="tw">
          <table className="rtable">
            <thead>
              <tr>
                <th>{t.users.cols.invite}</th>
                <th>{t.users.cols.role}</th>
                <th>{t.users.cols.status}</th>
                <th>{t.users.cols.by}</th>
                <th className="act" />
              </tr>
            </thead>
            <tbody>
              {list.data.map((i) => (
                <tr key={i.id}>
                  <td className="lead mono">{i.code}</td>
                  <td data-label={t.users.cols.role}>{t.shell.role[i.role]}</td>
                  <td data-label={t.users.cols.status}>
                    <Chip tone={i.state === 'open' ? 'ok' : ''}>{t.users.inviteState[i.state]}</Chip>{' '}
                    <span className="sub">
                      {i.state === 'used' && i.usedBy
                        ? t.users.usedBy(i.usedBy.displayName)
                        : t.users.until(dateTime(i.expiresAt))}
                    </span>
                  </td>
                  <td className="sub" data-label={t.users.cols.by}>
                    {i.createdBy?.displayName ?? '—'}
                  </td>
                  <td className="act">
                    {i.state === 'open' && (
                      <button
                        type="button"
                        onClick={async () => toast((await copyText(i.url)) ? t.users.copied : t.users.copyFailed)}
                      >
                        {t.users.copyLink}
                      </button>
                    )}
                    <button type="button" onClick={() => remove(i.id)}>
                      {i.state === 'open' ? t.users.revoke : t.users.clear}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="sub">{t.users.inviteNote}</p>
    </section>
  );
}
