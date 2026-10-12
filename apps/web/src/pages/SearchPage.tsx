import type { Me, MovieSummary } from '@paiban/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router';
import { Banner, Chip, Empty, PageHead } from '../components/Bits';
import { FillPage, ScrollList } from '../components/FillPage';
import { ManualTorrentDialog, type PresetFilm } from '../components/ManualTorrent';
import { Poster } from '../components/Poster';
import { Rating } from '../components/Rating';
import { SuggestInput } from '../components/SuggestInput';
import { t } from '../copy';
import { ApiFailure } from '../lib/api';
import { filmTitle } from '../lib/format';
import { useSearch } from '../lib/queries';

const GENRES = Object.keys(t.genres);

/** docs/11-pages.md, "Search (02, 18, 32)". The URL holds the query and filters, so back/forward and links work. */
export function SearchPage() {
  const me = useOutletContext<Me>();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => setQ(params.get('q') ?? ''), [params]);
  const page = Number(params.get('page') ?? 1) || 1;
  const query = new URLSearchParams();
  for (const k of ['q', 'quality', 'genre', 'minRating', 'sort'] as const) {
    const v = params.get(k);
    if (v) query.set(k, v);
  }
  if (page > 1) query.set('page', String(page));
  const res = useSearch(query.toString());

  const update = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    next.delete('page');
    setParams(next);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    update('q', q.trim());
  };
  const toPage = (n: number) => {
    const next = new URLSearchParams(params);
    if (n > 1) next.set('page', String(n));
    else next.delete('page');
    setParams(next);
    window.scrollTo({ top: 0 });
  };
  const keyword = params.get('q') ?? '';
  // Adding a torrent by hand when YTS does not have the film (Brian, 2026-10-09).
  const [manual, setManual] = useState<{ preset: PresetFilm | null } | null>(null);
  const filtered = ['quality', 'genre', 'minRating', 'sort'].some((k) => params.get(k));

  return (
    <FillPage>
      <PageHead title={t.search.title} lead={t.search.lead}>
        <button type="button" className="manual-open" onClick={() => setManual({ preset: null })}>
          <span aria-hidden="true">+</span> {t.manual.open}
        </button>
      </PageHead>
      {manual && <ManualTorrentDialog preset={manual.preset} onClose={() => setManual(null)} />}
      <form className="filters" onSubmit={submit} aria-label={t.search.title}>
        <SuggestInput
          value={q}
          onChange={setQ}
          placeholder={t.search.placeholder}
          label={t.search.placeholder}
          onMissing={(film) => setManual({ preset: film })}
        />
        <label className="sel-l">
          <span>{t.search.quality}</span>
          <select value={params.get('quality') ?? ''} onChange={(e) => update('quality', e.target.value)}>
            <option value="">{t.search.all}</option>
            <option value="720p">720p</option>
            <option value="1080p">1080p</option>
            <option value="2160p">2160p</option>
          </select>
        </label>
        <label className="sel-l">
          <span>{t.search.genre}</span>
          <select value={params.get('genre') ?? ''} onChange={(e) => update('genre', e.target.value)}>
            <option value="">{t.search.all}</option>
            {GENRES.map((g) => (
              <option key={g} value={g}>
                {t.genres[g]}
              </option>
            ))}
          </select>
        </label>
        <label className="sel-l">
          <span>{t.search.rating}</span>
          <select value={params.get('minRating') ?? ''} onChange={(e) => update('minRating', e.target.value)}>
            <option value="">{t.search.anyRating}</option>
            {[6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {t.search.ratingAtLeast(n)}
              </option>
            ))}
          </select>
        </label>
        <label className="sel-l">
          <span>{t.search.sort}</span>
          <select value={params.get('sort') ?? ''} onChange={(e) => update('sort', e.target.value)}>
            {(['added', 'rating', 'year', 'seeds'] as const).map((s) => (
              <option key={s} value={s === 'added' ? '' : s}>
                {t.search.sorts[s]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          {t.search.submit}
        </button>
      </form>

      {res.isError ? (
        <SearchError error={res.error} isAdmin={me.user.role === 'admin'} retry={() => res.refetch()} />
      ) : (
        <>
          <div className="rhead">
            <h2>{keyword ? t.search.resultsFor(keyword) : t.search.latest}</h2>
            {res.data && <span className="sub">{t.search.count(res.data.total)}</span>}
          </div>
          <ScrollList label={t.search.resultsLabel}>
            {!res.data ? (
              <div className="mgrid skel" role="status" aria-busy="true" aria-label={t.common.loading}>
                {Array.from({ length: 6 }, (_, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                  <div className="mcard" key={i}>
                    <div className="poster" />
                    <span className="mt">&nbsp;</span>
                    <span className="ms">&nbsp;</span>
                  </div>
                ))}
              </div>
            ) : res.data.items.length === 0 ? (
              <Empty
                title={keyword ? t.search.noResultsFor(keyword) : t.search.noResults}
                hint={t.search.noResultsHint}
              >
                {(keyword || filtered) && (
                  <button type="button" onClick={() => setParams(new URLSearchParams())}>
                    {t.search.clear}
                  </button>
                )}
                <p className="sub">{t.manual.emptyHint}</p>
                <button type="button" className="primary" onClick={() => setManual({ preset: null })}>
                  {t.manual.open}
                </button>
              </Empty>
            ) : (
              <>
                <div className={`mgrid${res.isFetching ? ' fetching' : ''}`}>
                  {res.data.items.map((m) => (
                    <MovieCard key={m.ytsId} m={m} />
                  ))}
                </div>
                <Pager page={res.data.page} total={res.data.total} pageSize={res.data.pageSize} onPage={toPage} />
              </>
            )}
          </ScrollList>
        </>
      )}
    </FillPage>
  );
}

function MovieCard({ m }: { m: MovieSummary }) {
  const name = filmTitle(m);
  return (
    <Link to={`/movies/${m.ytsId}`} className="mcard">
      <Poster url={m.posterUrl} title={m.title} year={m.year} runtimeMin={m.runtimeMin} />
      <span className="mt">{name.main}</span>
      <span className="ms">
        {name.other ? `${name.other} · ` : ''}
        {m.year}
        <Rating m={m} />
      </span>
      <span className="qs">
        {m.qualities.map((q) => (
          <i key={q}>{q}</i>
        ))}
      </span>
      {m.mine === 'ready' && <Chip tone="ok">{t.search.inLibrary}</Chip>}
      {m.mine === 'downloading' && <Chip tone="info">{t.search.downloading}</Chip>}
    </Link>
  );
}

function Pager({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPage: (n: number) => void;
}) {
  const last = Math.max(1, Math.ceil(total / pageSize));
  if (last <= 1) return null;
  return (
    <nav className="pager frow" aria-label={t.search.pageOf(page, total)}>
      <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        {t.search.prev}
      </button>
      <span className="sub">{t.search.pageOf(page, total)}</span>
      <button type="button" disabled={page >= last} onClick={() => onPage(page + 1)}>
        {t.search.next}
      </button>
    </nav>
  );
}

export function SearchError({ error, isAdmin, retry }: { error: unknown; isAdmin: boolean; retry: () => void }) {
  const code = error instanceof ApiFailure ? error.code : 'INTERNAL';
  if (code === 'YTS_NOT_CONFIGURED') {
    return (
      <Banner tone="warn">
        <span>{isAdmin ? t.search.notConfiguredAdmin : t.search.notConfiguredMember}</span>
        {isAdmin && (
          <Link className="btn" to="/admin/sources">
            {t.common.goSources}
          </Link>
        )}
      </Banner>
    );
  }
  if (code === 'YTS_UNREACHABLE' || code === 'YTS_BAD_RESPONSE') {
    return (
      <Banner tone="bad">
        <span>
          {code === 'YTS_UNREACHABLE' ? t.search.unreachable : t.search.badResponse}
          {isAdmin ? t.search.fixAdmin : t.search.fixMember}
        </span>
        <div className="frow">
          {isAdmin && (
            <Link className="btn" to="/admin/sources">
              {t.common.goSources}
            </Link>
          )}
          <button type="button" onClick={retry}>
            {t.common.retry}
          </button>
        </div>
      </Banner>
    );
  }
  return (
    <Banner tone="bad">
      <span>{code === 'NETWORK' ? t.common.offline : t.common.unknownError}</span>
      <button type="button" onClick={retry}>
        {t.common.retry}
      </button>
    </Banner>
  );
}
