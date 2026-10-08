import type { Me } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Outlet, type RouteObject, useLocation, useNavigate, useOutletContext } from 'react-router';
import { Banner } from './components/Bits';
import { Shell } from './components/Shell';
import { locale, setLocale, t } from './copy';
import { ApiFailure } from './lib/api';
import { useMe } from './lib/queries';
import { DownloadsPage } from './pages/DownloadsPage';
import { LibraryPage } from './pages/LibraryPage';
import { LoginPage } from './pages/LoginPage';
import { MoviePage } from './pages/MoviePage';
import { ProfilePage } from './pages/ProfilePage';
import { RegisterPage } from './pages/RegisterPage';
import { ResetPage } from './pages/ResetPage';
import { SearchPage } from './pages/SearchPage';
import { ForbiddenPage, NotFoundPage } from './pages/StatusPages';
import { StoragePage } from './pages/StoragePage';

/** Signed-in area: not signed in goes to /login and comes back afterwards (docs/11-pages.md, "路徑"). */
function RequireAuth() {
  const me = useMe();
  const location = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    // Any 401 later (session ended, account disabled) sends the person back to sign in.
    const onLost = () => {
      qc.clear();
      navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true });
    };
    window.addEventListener('paiban:unauthenticated', onLost);
    return () => window.removeEventListener('paiban:unauthenticated', onLost);
  }, [navigate, qc, location]);
  // The language kept with the account wins over this device's (it follows the person around).
  const wanted = me.data?.user.prefs.locale ?? null;
  useEffect(() => {
    if (wanted && wanted !== locale) setLocale(wanted);
  }, [wanted]);

  if (me.isPending) return <div className="boot" role="status" aria-busy="true" aria-label={t.common.loading} />;
  if (me.isError) {
    if (me.error instanceof ApiFailure && me.error.status === 401)
      return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
    return (
      <div className="auth">
        <div className="box">
          <Banner tone="bad">
            <span>
              {me.error instanceof ApiFailure && me.error.code === 'NETWORK' ? t.common.offline : t.common.unknownError}
            </span>
            <button type="button" onClick={() => me.refetch()}>
              {t.common.retry}
            </button>
          </Banner>
        </div>
      </div>
    );
  }
  return <Shell me={me.data} />;
}

function RequireAdmin() {
  const me = useOutletContext<Me>();
  return me.user.role === 'admin' ? <Outlet context={me} /> : <ForbiddenPage />;
}

/**
 * The film workspace (with the sync workbench) and the administrator pages load on first visit:
 * most visits never open them, and together they were most of the bundle.
 */
function workspace(tab: 'subtitles' | 'sync' | 'export') {
  return async () => {
    const { WorkspacePage } = await import('./pages/workspace/WorkspacePage');
    return { Component: () => <WorkspacePage tab={tab} /> };
  };
}

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/invite/:code?', element: <RegisterPage /> },
  { path: '/reset/:token', element: <ResetPage /> },
  {
    element: <RequireAuth />,
    children: [
      { index: true, element: <Navigate to="/search" replace /> },
      { path: 'search', element: <SearchPage /> },
      { path: 'movies/:ytsId', element: <MoviePage /> },
      { path: 'downloads', element: <DownloadsPage /> },
      {
        path: 'downloads/:torrentId',
        lazy: async () => ({ Component: (await import('./downloads/DownloadDetailPage')).DownloadDetailPage }),
      },
      { path: 'library', element: <LibraryPage /> },
      { path: 'library/:torrentId', element: <Navigate to="subtitles" replace /> },
      { path: 'library/:torrentId/subtitles', lazy: workspace('subtitles') },
      { path: 'library/:torrentId/sync/:subtitleId?', lazy: workspace('sync') },
      { path: 'library/:torrentId/export', lazy: workspace('export') },
      { path: 'storage', element: <StoragePage /> },
      { path: 'profile', element: <ProfilePage /> },
      {
        path: 'admin',
        element: <RequireAdmin />,
        children: [
          { index: true, lazy: async () => ({ Component: (await import('./pages/admin/OverviewPage')).OverviewPage }) },
          { path: 'users', lazy: async () => ({ Component: (await import('./pages/admin/UsersPage')).UsersPage }) },
          { path: 'audit', lazy: async () => ({ Component: (await import('./pages/admin/AuditPage')).AuditPage }) },
          {
            path: 'storage',
            lazy: async () => ({ Component: (await import('./pages/admin/StorageAdminPage')).StorageAdminPage }),
          },
          {
            path: 'sources',
            lazy: async () => ({ Component: (await import('./pages/admin/SourcesPage')).SourcesPage }),
          },
          { path: 'llm', lazy: async () => ({ Component: (await import('./pages/admin/LlmPage')).LlmPage }) },
          {
            path: 'downloads',
            lazy: async () => ({
              Component: (await import('./pages/admin/DownloadSettingsPage')).DownloadSettingsPage,
            }),
          },
          { path: 'system', lazy: async () => ({ Component: (await import('./pages/admin/SystemPage')).SystemPage }) },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
