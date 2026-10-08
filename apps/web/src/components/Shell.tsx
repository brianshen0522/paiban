import { type Me, type Notification, SITE_NAME } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { t } from '../copy';
import { post } from '../lib/api';
import { useServerEvents } from '../lib/events';
import { bytes, relative } from '../lib/format';
import { keys, useNotifications, useStorage, useTorrents } from '../lib/queries';
import { langName } from '../pages/workspace/SubtitlesTab';
import { LocaleToggle } from './LocaleToggle';
import { SuggestInput } from './SuggestInput';
import { ThemeToggle } from './ThemeToggle';
import { useToast } from './Toasts';
import { meterLevel } from './Usage';

/** Where a notification leads (docs/11-pages.md, "通知"). */
export function notificationTarget(n: Notification): string {
  if (!n.link) return n.kind.startsWith('export.') ? '/storage' : '/library';
  if (n.link.page === 'downloads') return '/downloads';
  return n.link.torrentId ? `/library/${n.link.torrentId}/${n.link.tab ?? 'subtitles'}` : '/library';
}

export function notificationText(n: Notification): string {
  const d = n.data;
  const title = d.movieTitle ?? d.fileName ?? '';
  switch (n.kind) {
    case 'download.completed':
      return t.notifications['download.completed'](title, d.version ?? '');
    case 'download.failed':
      return t.notifications['download.failed'](title, d.version ?? '');
    case 'export.completed':
      return t.notifications['export.completed'](title);
    case 'export.failed':
      return t.notifications['export.failed'](title);
    case 'subtitle.confirmed':
      return t.notifications['subtitle.confirmed'](d.actor ?? '', title, langName(d.language ?? ''));
    case 'item.deleted':
      return t.notifications['item.deleted'](d.actor ?? '', t.itemKinds[d.itemKind ?? ''] ?? d.itemKind ?? '', title);
    default:
      return title;
  }
}

/** Closes a popup on outside click and Esc (docs/17-ui.md, "彈出選單"). */
function usePopup(): [boolean, (v: boolean) => void, React.RefObject<HTMLDivElement | null>] {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return [open, setOpen, ref];
}

export function Shell({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const storage = useStorage();
  const torrents = useTorrents('mine');
  const notifications = useNotifications();
  const [q, setQ] = useState('');
  const [notesOpen, setNotesOpen, notesRef] = usePopup();
  const [menuOpen, setMenuOpen, menuRef] = usePopup();
  const isAdmin = me.user.role === 'admin';

  const onNotification = useCallback(
    (n: Notification) => {
      // Finished downloads and exports also pop up while the person has the site open (docs/11, "通知").
      if (n.kind === 'download.completed' || n.kind === 'export.completed')
        toast(notificationText(n), { label: t.common.open, run: () => navigate(notificationTarget(n)) });
    },
    [toast, navigate],
  );
  useServerEvents(true, onNotification);

  // Move focus to the page heading after navigation, for keyboard and screen-reader users.
  const mainRef = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every route change on purpose
  useEffect(() => {
    mainRef.current?.querySelector<HTMLElement>('h1')?.setAttribute('tabindex', '-1');
    setNotesOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  const active = (torrents.data ?? []).filter(
    (x) => x.status === 'queued' || x.status === 'downloading' || x.status === 'paused',
  ).length;
  const usage = storage.data?.usage;
  const unread = notifications.data?.unread ?? 0;

  const search = (e: FormEvent) => {
    e.preventDefault();
    navigate(q.trim() ? `/search?q=${encodeURIComponent(q.trim())}` : '/search');
  };

  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    navigate('/login', { replace: true });
  };

  const readAll = async () => {
    await post('/api/notifications/read', { all: true });
    await qc.invalidateQueries({ queryKey: keys.notifications });
  };
  const openNote = async (n: Notification) => {
    setNotesOpen(false);
    if (!n.read) {
      await post('/api/notifications/read', { ids: [n.id] }).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: keys.notifications });
    }
    navigate(notificationTarget(n));
  };

  const nav = [
    { to: '/search', label: t.shell.nav.search },
    { to: '/downloads', label: t.shell.nav.downloads, count: active },
    { to: '/library', label: t.shell.nav.library },
    { to: '/storage', label: t.shell.nav.storage },
    { to: '/profile', label: t.shell.nav.profile },
  ];
  const adminNav = [
    { to: '/admin', label: t.shell.admin.overview, end: true },
    { to: '/admin/users', label: t.shell.admin.users },
    { to: '/admin/storage', label: t.shell.admin.storage },
    { to: '/admin/sources', label: t.shell.admin.sources },
    { to: '/admin/llm', label: t.shell.admin.llm },
    { to: '/admin/downloads', label: t.shell.admin.downloads },
    { to: '/admin/system', label: t.shell.admin.system },
    { to: '/admin/audit', label: t.shell.admin.audit },
  ];

  return (
    <div className="shell">
      <a className="skip" href="#main">
        {t.shell.skipToContent}
      </a>
      <header className="top">
        <Link to="/search" className="brand">
          <i aria-hidden="true" />
          {SITE_NAME}
        </Link>
        <form className="gsearch" onSubmit={search} aria-label={t.shell.searchButton}>
          <SuggestInput
            value={q}
            onChange={setQ}
            placeholder={t.shell.searchPlaceholder}
            label={t.shell.searchPlaceholder}
          />
          <button type="submit">{t.shell.searchButton}</button>
        </form>
        <div className="right">
          <Link to="/storage" className={`meter ${usage ? meterLevel(usage) : ''}`} title={t.shell.usageTitle}>
            <span className="bar" aria-hidden="true">
              <i
                style={{
                  width:
                    usage && usage.limitBytes > 0
                      ? `${Math.min(100, (usage.usedBytes / usage.limitBytes) * 100)}%`
                      : '0%',
                }}
              />
            </span>
            <span className="mono">
              {usage ? (
                <>
                  {bytes(usage.usedBytes)}
                  <span className="meter-limit"> / {bytes(usage.limitBytes)}</span>
                </>
              ) : (
                t.shell.usageUnknown
              )}
            </span>
          </Link>
          <LocaleToggle />
          <ThemeToggle />
          <div className="popwrap" ref={notesRef}>
            <button
              type="button"
              aria-expanded={notesOpen}
              aria-haspopup="true"
              onClick={() => setNotesOpen(!notesOpen)}
            >
              {t.shell.notifications}
              {unread > 0 && (
                <span className="count">
                  <span aria-hidden="true">{unread}</span>
                  <span className="sr-only">{t.shell.unreadCount(unread)}</span>
                </span>
              )}
            </button>
            {notesOpen && (
              <div className="pop">
                <div className="pop-head">
                  <strong>{t.shell.notifications}</strong>
                  {unread > 0 && (
                    <button type="button" className="link" onClick={readAll}>
                      {t.shell.markAllRead}
                    </button>
                  )}
                </div>
                {(notifications.data?.items ?? []).length === 0 && <p className="pad sub">{t.shell.noNotifications}</p>}
                {(notifications.data?.items ?? []).slice(0, 8).map((n) => (
                  <button
                    type="button"
                    key={n.id}
                    className={`pop-item${n.read ? '' : ' unread'}`}
                    onClick={() => openNote(n)}
                  >
                    <span>{notificationText(n)}</span>
                    <small className="pop-when">{relative(n.createdAt)}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="popwrap" ref={menuRef}>
            <button
              type="button"
              className="avatar"
              aria-label={t.shell.accountMenu}
              aria-expanded={menuOpen}
              aria-haspopup="true"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {me.user.displayName.slice(0, 1).toUpperCase()}
            </button>
            {menuOpen && (
              <div className="pop">
                <div className="pop-head">
                  <span>
                    <strong>{me.user.displayName}</strong> <span className="sub">{t.shell.role[me.user.role]}</span>
                  </span>
                </div>
                <Link className="pop-item" to="/profile">
                  <span>{t.shell.profile}</span>
                </Link>
                <button type="button" className="pop-item" onClick={logout}>
                  <span>{t.shell.logout}</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>
      <nav className="side" aria-label={t.shell.navLabel}>
        {nav.map((n) => (
          <NavLink key={n.to} to={n.to}>
            <span>{n.label}</span>
            {n.count ? <span className="count">{n.count}</span> : null}
          </NavLink>
        ))}
        {isAdmin && (
          <>
            <h2>{t.shell.adminHeading}</h2>
            {adminNav.map((n) => (
              <NavLink key={n.to} to={n.to} end={'end' in n}>
                <span>{n.label}</span>
              </NavLink>
            ))}
          </>
        )}
      </nav>
      <main className="main" id="main" ref={mainRef}>
        <div id="view">
          <Outlet context={me} />
        </div>
      </main>
    </div>
  );
}
