import type { TmdbSuggestion } from '@paiban/shared';
import { useQuery } from '@tanstack/react-query';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { t } from '../copy/zh-TW';
import { get } from '../lib/api';

/** Typing pauses this long before TMDB is asked. */
const DEBOUNCE_MS = 250;

type Pick = { tmdbId: number; state: 'finding' | 'missing' | 'failed' };

/**
 * A search box that offers TMDB's films while you type (Brian, 2026-10-06): YTS only understands
 * English titles, TMDB also Chinese ones. Picking a film looks up the same film on YTS by its IMDb
 * code and opens it; Enter without a highlighted film searches YTS for the text, as before.
 * A combobox in the ARIA sense: arrows move through the list, Esc closes it.
 */
export function SuggestInput({
  value,
  onChange,
  placeholder,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
}) {
  const navigate = useNavigate();
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setTimeout(() => setTyped(value.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [value]);

  const res = useQuery({
    queryKey: ['tmdb-suggest', typed],
    queryFn: () =>
      get<{ items: TmdbSuggestion[]; available: boolean }>(`/api/tmdb/suggest?q=${encodeURIComponent(typed)}`),
    enabled: open && typed.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
  const items = typed && res.data?.available ? res.data.items : [];
  const shown = open && items.length > 0;

  // Clicking anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const choose = async (s: TmdbSuggestion) => {
    setPick({ tmdbId: s.tmdbId, state: 'finding' });
    try {
      const r = await get<{ ytsId: number | null }>(`/api/tmdb/${s.tmdbId}/yts`);
      if (r.ytsId === null) {
        setPick({ tmdbId: s.tmdbId, state: 'missing' });
        return;
      }
      setPick(null);
      setOpen(false);
      navigate(`/movies/${r.ytsId}`);
    } catch {
      setPick({ tmdbId: s.tmdbId, state: 'failed' });
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      if (shown) e.preventDefault();
      setOpen(false);
      setActive(-1);
      return;
    }
    if (!shown) {
      if (e.key === 'ArrowDown') setOpen(true);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      setActive((a) => (e.key === 'ArrowDown' ? (a + 1) % n : (a <= 0 ? n : a) - 1));
      return;
    }
    if (e.key === 'Enter') {
      const s = items[active];
      // A highlighted film opens it; otherwise the form searches YTS for the text as before.
      if (s) {
        e.preventDefault();
        void choose(s);
      } else setOpen(false);
    }
  };

  const note = (s: TmdbSuggestion) =>
    pick?.tmdbId !== s.tmdbId
      ? null
      : pick.state === 'finding'
        ? t.suggest.finding
        : pick.state === 'missing'
          ? t.suggest.missing
          : t.suggest.failed;

  return (
    <div className="suggest" ref={wrap}>
      <input
        type="search"
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
          setPick(null);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder}
        aria-label={label}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
      />
      {shown && (
        <div className="suggest-pop">
          <p className="suggest-head">{t.suggest.heading}</p>
          <div id={listId} role="listbox" aria-label={t.suggest.listLabel} className="suggest-list">
            {items.map((s, i) => {
              const n = note(s);
              return (
                // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox pattern: keys are handled on the input (aria-activedescendant)
                <div
                  key={s.tmdbId}
                  tabIndex={-1}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'on' : undefined}
                  // Keep focus in the box: a click picks without blurring the input first.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void choose(s)}
                  onMouseEnter={() => setActive(i)}
                >
                  {s.posterUrl ? (
                    <img src={s.posterUrl} alt="" width={32} height={48} loading="lazy" />
                  ) : (
                    <span className="suggest-noimg" aria-hidden="true" />
                  )}
                  <span className="suggest-text">
                    <b>{s.title}</b>
                    <small>
                      {[s.originalTitle !== s.title ? s.originalTitle : null, s.year].filter(Boolean).join(' · ')}
                    </small>
                    {n && (
                      <small className={pick?.state === 'finding' ? 'suggest-note' : 'suggest-note bad'}>{n}</small>
                    )}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="suggest-foot">{t.suggest.enterHint(value.trim())}</p>
        </div>
      )}
    </div>
  );
}
