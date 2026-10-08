import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/oswald/latin-500.css';
import '@fontsource/oswald/latin-600.css';
// Chinese for systems without PingFang or JhengHei (Linux, Android): bundled, split by character
// range, so a page fetches only the slices it uses. Mac and Windows use their own font first.
import '@fontsource/noto-sans-tc/400.css';
import '@fontsource/noto-sans-tc/500.css';
import '@fontsource/noto-sans-tc/600.css';
import './styles/app.css';
import './styles/workspace.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { ToastProvider } from './components/Toasts';
import { initialLocale, locale, onLocale, setLocale } from './copy';
import { applyTheme, readTheme } from './lib/theme';
import { routes } from './routes';

applyTheme(readTheme());
// Before anything renders: this device's last choice, else the browser's language (Brian, 2026-10-08).
setLocale(initialLocale());

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 15_000, refetchOnWindowFocus: true, retry: 1 } },
});
const router = createBrowserRouter(routes);

/**
 * Every component reads the copy as it renders, so a change of language mounts the pages again
 * (the router, its address and the data cache stay; a half-typed form does not).
 */
function Root() {
  const [current, setCurrent] = useState(locale);
  useEffect(() => onLocale(setCurrent), []);
  return <RouterProvider key={current} router={router} />;
}

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <Root />
        </ToastProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
