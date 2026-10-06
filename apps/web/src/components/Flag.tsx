import { useEffect, useState } from 'react';

/**
 * Country flags from the flag-icons package (MIT), bundled with the site: emoji flags show as two
 * letters on Windows, and the page loads nothing from other sites (D30). Each flag is fetched
 * only when a country actually appears.
 */
const FLAGS = import.meta.glob<string>('../../node_modules/flag-icons/flags/4x3/*.svg', {
  query: '?url',
  import: 'default',
});

export function Flag({ code }: { code: string | null }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    const load = code ? FLAGS[`../../node_modules/flag-icons/flags/4x3/${code.toLowerCase()}.svg`] : undefined;
    let live = true;
    load?.().then((u) => {
      if (live) setUrl(u);
    });
    return () => {
      live = false;
    };
  }, [code]);
  return url ? (
    <img className="flag" src={url} alt="" width={20} height={15} loading="lazy" />
  ) : (
    <span className="flag flag-none" aria-hidden="true" />
  );
}
