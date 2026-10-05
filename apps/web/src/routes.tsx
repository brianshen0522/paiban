import type { Me } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Navigate, Outlet, type RouteObject, useLocation, useNavigate, useOutletContext } from 'react-router';
import { Banner } from './components/Bits';
import { Shell } from './components/Shell';
import { t } from './copy/zh-TW';
import { ApiFailure } from './lib/api';
import { useMe } from './lib/queries';
import { AuditPage } from './pages/admin/AuditPage';
import { DownloadSettingsPage } from './pages/admin/DownloadSettingsPage';
import { OverviewPage } from './pages/admin/OverviewPage';
import { SourcesPage } from './pages/admin/SourcesPage';
import { StorageAdminPage } from './pages/admin/StorageAdminPage';
import { UsersPage } from './pages/admin/UsersPage';
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
      { path: 'library', element: <LibraryPage /> },
      { path: 'storage', element: <StoragePage /> },
      { path: 'profile', element: <ProfilePage /> },
      {
        path: 'admin',
        element: <RequireAdmin />,
        children: [
          { index: true, element: <OverviewPage /> },
          { path: 'users', element: <UsersPage /> },
          { path: 'audit', element: <AuditPage /> },
          { path: 'storage', element: <StorageAdminPage /> },
          { path: 'sources', element: <SourcesPage /> },
          { path: 'downloads', element: <DownloadSettingsPage /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
