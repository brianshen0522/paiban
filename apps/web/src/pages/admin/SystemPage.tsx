import type { ServiceStatus, Task } from '@paiban/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Banner, Chip, PageHead, Skeleton, type Tone } from '../../components/Bits';
import { SpaceShort } from '../../components/SpaceShort';
import { useToast } from '../../components/Toasts';
import { live, t } from '../../copy';
import { type ApiFailure, asFailure, isSpaceError, post } from '../../lib/api';
import { bytes, percent } from '../../lib/format';
import { keys, useAdminSystem, useStorage } from '../../lib/queries';

const s = live('system');

/** "40 秒", "3 分 20 秒", "2 小時", "9 天". */
export function durationText(seconds: number): string {
  const d = s.duration;
  if (seconds < 60) return d.seconds(Math.max(0, Math.round(seconds)));
  if (seconds < 3600) return d.minutes(Math.floor(seconds / 60), Math.round(seconds % 60));
  if (seconds < 86400) return d.hours(Math.floor(seconds / 3600));
  return d.days(Math.floor(seconds / 86400));
}

/** How long a service has been up: no seconds, "不到 1 分鐘" under a minute. */
export function uptimeText(since: string, now = Date.now()): string {
  const sec = Math.max(0, (now - Date.parse(since)) / 1000);
  if (sec < 60) return s.duration.underMinute;
  if (sec < 3600) return s.duration.minutes(Math.floor(sec / 60), 0);
  return durationText(sec);
}

export const taskKind = (k: string): string => s.kinds[k] ?? t.overview.taskKinds[k] ?? k;

export function taskError(code: string | null): string {
  if (!code) return t.common.unknownError;
  return t.overview.taskErrors[code] ?? t.media.otherError(code);
}

/** What a task is about, from its subject data. */
export function taskItem(task: Task): string {
  const x = task.subject;
  const parts = [x.fileName ?? x.movieTitle, x.version, x.language ? (t.langs[x.language] ?? x.language) : null];
  const text = parts.filter(Boolean).join(' · ');
  return text || (task.kind === 'rescan' ? s.allMedia : '—');
}

export function taskNote(task: Task): string {
  if (task.state === 'running') return s.inProgress(percent(task.progress));
  if (task.state === 'failed') return taskError(task.errorCode);
  if (task.state === 'done') {
    const took = task.seconds != null ? s.took(durationText(task.seconds)) : '';
    const sum =
      task.kind === 'rescan' && task.summary
        ? s.rescanSummary(task.summary.corrected ?? 0, task.summary.orphans ?? 0, task.summary.missing ?? 0)
        : '';
    return [took, sum].filter(Boolean).join(' · ');
  }
  return '';
}

const TASK_TONE: Record<Task['state'], Tone> = {
  queued: '',
  running: 'info',
  done: 'ok',
  failed: 'bad',
  cancelled: '',
};

/** docs/11-pages.md, "System status (20)": services, background tasks, the disk. Polls every 10 seconds. */
export function SystemPage() {
  const q = useAdminSystem();
  const storage = useStorage();
  if (q.isError)
    return (
      <>
        <PageHead title={s.title} lead={s.lead} />
        <Banner tone="bad">
          <span>{s.loadError}</span>
          <button type="button" onClick={() => q.refetch()}>
            {t.common.retry}
          </button>
        </Banner>
      </>
    );
  if (!q.data)
    return (
      <>
        <PageHead title={s.title} lead={s.lead} />
        <Skeleton lines={6} />
      </>
    );
  const { services, tasks, disk } = q.data;
  const usage = storage.data?.usage;
  return (
    <>
      <PageHead title={s.title} lead={s.lead} />
      <section className="card">
        <h2>{s.services}</h2>
        <div className="tw">
          <table>
            <thead>
              <tr>
                <th>{s.cols.name}</th>
                <th>{s.cols.purpose}</th>
                <th>{s.cols.state}</th>
                <th>{s.cols.uptime}</th>
              </tr>
            </thead>
            <tbody>
              {services.map((x) => (
                <ServiceRow key={x.name} x={x} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="sub">{s.servicesNote}</p>
      </section>
      <section className="card">
        <h2>{s.tasks}</h2>
        {tasks.length === 0 ? (
          <p className="sub">{s.noTasks}</p>
        ) : (
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>{s.tcols.kind}</th>
                  <th>{s.tcols.item}</th>
                  <th>{s.tcols.state}</th>
                  <th>{s.tcols.note}</th>
                  <th className="act">{s.tcols.action}</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((x) => (
                  <TaskRow key={x.id} task={x} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>{s.disk}</h2>
        <p className="sub">
          {s.diskLine(
            bytes(disk.totalBytes),
            bytes(disk.reserveBytes),
            usage ? bytes(usage.limitBytes) : '—',
            usage ? bytes(usage.usedBytes) : '—',
          )}
        </p>
        <div>
          <Link className="btn" to="/admin/storage">
            {s.toStorage}
          </Link>
        </div>
      </section>
    </>
  );
}

function ServiceRow({ x }: { x: ServiceStatus }) {
  const purpose = s.purposes[x.name] ?? x.name;
  return (
    <tr>
      <td className="mono">{x.name}</td>
      <td>{x.version ? s.withVersion(purpose, x.version) : purpose}</td>
      <td>{x.state === 'up' ? <Chip tone="ok">{s.up}</Chip> : <Chip tone="bad">{s.down}</Chip>}</td>
      <td className="sub">{x.since ? (x.state === 'up' ? uptimeText(x.since) : '—') : s.neverReported}</td>
    </tr>
  );
}

function TaskRow({ task }: { task: Task }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure | null>(null);
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await post<Task>(`/api/admin/tasks/${task.id}/retry`);
      toast(s.retried);
      void qc.invalidateQueries({ queryKey: keys.adminSystem });
    } catch (e) {
      setError(asFailure(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <tr>
        <td>{taskKind(task.kind)}</td>
        <td className="rel">{taskItem(task)}</td>
        <td>
          <Chip tone={TASK_TONE[task.state]}>{s.states[task.state]}</Chip>
        </td>
        <td className="sub">{taskNote(task)}</td>
        <td className="act">
          {task.retryable && (
            <button type="button" disabled={busy} onClick={retry}>
              {s.retry}
            </button>
          )}
        </td>
      </tr>
      {error && (
        <tr className="blocked">
          <td colSpan={5}>
            {isSpaceError(error) ? (
              <SpaceShort error={error} retry onClose={() => setError(null)} />
            ) : (
              <Banner tone="bad">
                <span>{error.code === 'NETWORK' ? t.common.offline : t.common.unknownError}</span>
                <button type="button" onClick={() => setError(null)}>
                  {t.common.gotIt}
                </button>
              </Banner>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
