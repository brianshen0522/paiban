import { SITE_NAME } from '@paiban/shared';
import { useEffect } from 'react';
import { copy } from './copy';

export function App() {
  useEffect(() => {
    document.title = SITE_NAME;
  }, []);
  return (
    <main className="placeholder">
      <h1>{SITE_NAME}</h1>
      <p>{copy.placeholder.tagline}</p>
      <p className="muted">{copy.placeholder.status}</p>
    </main>
  );
}
