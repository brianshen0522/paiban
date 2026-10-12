import type { AdminOverview, TorrentErrorCode } from '@paiban/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Banner, Chip, PageHead, Skeleton } from '../../components/Bits';
import { live, t } from '../../copy';
import { get } from '../../lib/api';
import { bytes, percent, relative } from '../../lib/format';
import { actionText, targetText, when } from './AuditPage';
import { taskKind } from './SystemPage';

type Problem = AdminOverview['problems'][number];
const o = live('overview');

/** Where each problem's button goes. */
const PAGE: Record<Problem['page'], string> = {
  storage: '/admin/storage',
  downloads: '/downloads?all=1',
  sources: '/admin/sources',
  system: '/admin/system',
};

/** A source's problem opens the settings tab that source is on: movie data or subtitle sources. */
function sourcesTab(p: Problem): string {
  const source = String(p.data.source ?? '');
  const movies = p.code.startsWith('YTS_') || source === 'yts' || source === 'tmdb';
  return `${PAGE.sources}?tab=${movies ? 'movies' : 'subtitles'}`;
}

function sentence(p: Problem): string {
  const d = p.data;
  const s = String;
  switch (p.code) {
    case 'OVER_LIMIT':
      return o.problems.OVER_LIMIT;
    case 'NEARLY_FULL':
      return o.problems.NEARLY_FULL(bytes(Number(d.freeBytes)));
    case 'DISK_LOW':
      return o.problems.DISK_LOW(bytes(Number(d.availableBytes)));
    case 'FAILED_DOWNLOAD': {
      const reason = t.downloads.errors[s(d.errorCode) as TorrentErrorCode] ?? s(d.errorCode);
      return o.problems.FAILED_DOWNLOAD(
        s(d.movieTitle),
        s(d.version),
        s(d.requestedBy ?? ''),
        reason,
        Number(d.bytes) > 0 ? bytes(Number(d.bytes)) : '',
      );
    }
    case 'YTS_NOT_CONFIGURED':
      return o.problems.YTS_NOT_CONFIGURED;
    case 'YTS_DOWN':
      return o.problems.YTS_DOWN;
    case 'SOURCE_DOWN': {
      const code = s(d.code) as keyof typeof t.tests;
      const why = typeof t.tests[code] === 'string' ? (t.tests[code] as string) : s(d.code);
      return o.problems.SOURCE_DOWN(o.sourceNames[s(d.source)] ?? s(d.source), why);
    }
    case 'FAILED_TASK':
      return o.problems.FAILED_TASK(
        o.taskKinds[s(d.kind)] ?? s(d.kind),
        s(d.movieTitle),
        o.taskErrors[s(d.errorCode)] ?? `${t.common.unknownError} ${s(d.errorCode)}`,
      );
    case 'SERVICE_DOWN':
      return o.problems.SERVICE_DOWN(o.services[s(d.service)] ?? s(d.service));
    case 'MISSING_FILES':
      return o.problems.MISSING_FILES(Number(d.count));
    case 'ORPHANS':
      return o.problems.ORPHANS(Number(d.count), bytes(Number(d.bytes)));
    case 'NO_HOLDERS':
      return o.problems.NO_HOLDERS(Number(d.count));
  }
}

function actionLabel(p: Problem): string {
  if (p.code === 'OVER_LIMIT') return o.actions.handle;
  if (p.code === 'YTS_NOT_CONFIGURED') return o.actions.configure;
  if (p.code === 'YTS_DOWN') return o.actions.updateUrl;
  return o.actions.view;
}

/** docs/11-pages.md, "Overview (14)". */
export function OverviewPage() {
  const q = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => get<AdminOverview>('/api/admin/overview'),
    refetchInterval: 15_000,
  });
  if (q.isError)
    return (
      <>
        <PageHead title={o.title} lead={o.lead} />
        <Banner tone="bad">
          <span>{t.common.unknownError}</span>
          <button type="button" onClick={() => q.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      </>
    );
  if (!q.data)
    return (
      <>
        <PageHead title={o.title} lead={o.lead} />
        <Skeleton lines={6} />
      </>
    );
  const d = q.data;
  return (
    <>
      <PageHead title={o.title} lead={o.lead} />
      <div className="tiles">
        <Link className="tile" to="/admin/storage">
          <small>{o.tiles.capacity}</small>
          <b>{bytes(d.usage.usedBytes)}</b>
          <span>{o.tiles.capacityNote(bytes(d.usage.limitBytes), bytes(d.usage.freeBytes))}</span>
        </Link>
        <Link className="tile" to="/downloads?all=1">
          <small>{o.tiles.downloads}</small>
          <b>
            {d.downloads.active} / {d.downloads.maxActive}
          </b>
          <span>{d.downloads.queued ? o.tiles.queued(d.downloads.queued) : o.tiles.noQueue}</span>
        </Link>
        <Link className="tile" to="/admin/users">
          <small>{o.tiles.users}</small>
          <b>{d.users.active}</b>
          <span>{o.tiles.usersNote(d.users.disabled, d.users.openInvites)}</span>
        </Link>
        <Link className="tile" to="/admin/system">
          <small>{o.tiles.tasks}</small>
          <b>{d.tasks.running}</b>
          <span>
            {d.tasks.current
              ? o.tiles.current(taskKind(d.tasks.current.kind), percent(d.tasks.current.progress))
              : o.tiles.noTasks}
          </span>
        </Link>
      </div>

      <section className="card">
        <h2>{o.attention}</h2>
        {d.problems.length === 0 ? (
          <p className="sub">{o.nothing}</p>
        ) : (
          <ul className="plist">
            {d.problems.map((p, i) => {
              const to = p.page === 'sources' ? sourcesTab(p) : PAGE[p.page];
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: problems have no id and the list is rebuilt whole
                <li key={i}>
                  <Chip tone={p.level === 'bad' ? 'bad' : 'warn'}>{o.levels[p.level]}</Chip>
                  <span>{sentence(p)}</span>
                  {to && (
                    <Link className="btn" to={to}>
                      {actionLabel(p)}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <div className="two">
        <section className="card">
          <h2>{o.sources}</h2>
          <ul className="feed">
            {d.sources.map((src) => (
              <li key={src.id}>
                <span>{o.sourceNames[src.id] ?? src.id}</span>
                <span className="frow">
                  <Chip
                    tone={src.state === 'ok' ? 'ok' : src.state === 'warn' ? 'warn' : src.state === 'down' ? 'bad' : ''}
                  >
                    {o.sourceStates[src.state]}
                  </Chip>
                  <small>{src.checkedAt ? relative(src.checkedAt) : o.notChecked}</small>
                </span>
              </li>
            ))}
          </ul>
          <Link className="btn" to="/admin/sources">
            {o.toSources}
          </Link>
        </section>
        <section className="card">
          <h2>{o.recent}</h2>
          {d.recent.length === 0 ? (
            <p className="sub">{o.noRecent}</p>
          ) : (
            <ul className="feed">
              {d.recent.map((e) => (
                <li key={e.id}>
                  <span>
                    <b>{e.actorName || e.actor?.displayName}</b> {actionText(e)}
                    {targetText(e) ? `：${targetText(e)}` : ''}
                  </span>
                  <small>{when(e.at)}</small>
                </li>
              ))}
            </ul>
          )}
          <Link className="btn" to="/admin/audit">
            {o.allLog}
          </Link>
        </section>
      </div>
    </>
  );
}
