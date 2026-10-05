import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Child processes for ffmpeg, ffprobe and ffsubsync: argument arrays, never a shell
 * (docs/12-auth.md, "執行外部程式"), with a handle to stop them when the job is cancelled.
 */
export type Running = { child: ChildProcess; done: Promise<{ code: number | null; stderr: string; stdout: string }> };

/** Children still running, so a shutdown can stop them (they would outlive the process otherwise). */
const live = new Set<ChildProcess>();
export function killAll(): void {
  for (const c of live) c.kill('SIGKILL');
}

export function run(cmd: string, args: string[], opts: { nice?: boolean; stdout?: 'collect' | 'pipe' } = {}): Running {
  const [bin, argv] = opts.nice ? ['nice', ['-n', '10', cmd, ...args]] : [cmd, args];
  const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(child);
  child.on('close', () => live.delete(child));
  let stderr = '';
  let stdout = '';
  child.stderr?.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  if (opts.stdout !== 'pipe')
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
  const done = new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve) => {
    child.on('error', (err) => resolve({ code: -1, stderr: String(err), stdout }));
    child.on('close', (code) => resolve({ code, stderr, stdout }));
  });
  return { child, done };
}

export class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

/**
 * Runs `fn` while checking `stillWanted` every two seconds; when it says no, `onCancel` stops the
 * child and the job ends with Cancelled (docs/08-media-pipeline.md, "執行中每 2 秒確認一次").
 */
export async function watched<T>(
  fn: () => Promise<T>,
  stillWanted: () => Promise<boolean>,
  onCancel: () => void,
  everyMs = 2000,
): Promise<T> {
  let cancelled = false;
  const timer = setInterval(() => {
    void stillWanted().then(
      (ok) => {
        if (!ok && !cancelled) {
          cancelled = true;
          onCancel();
        }
      },
      () => undefined,
    );
  }, everyMs);
  try {
    const out = await fn();
    if (cancelled) throw new Cancelled();
    return out;
  } finally {
    clearInterval(timer);
  }
}
