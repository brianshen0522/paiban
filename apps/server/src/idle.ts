import type { Logger } from 'pino';

/**
 * Phase 0 placeholder for the torrent and media services: a process that stays up (so the
 * container does not restart in a loop), writes a line periodically and exits cleanly on SIGTERM.
 * The database heartbeat replaces the log line in phase 1.
 */
export function runIdle(log: Logger, intervalMs = 60_000): void {
  log.info('started; no work yet in phase 0');
  const timer = setInterval(() => log.info('alive'), intervalMs);
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      log.info({ signal }, 'shutting down');
      process.exit(0);
    });
  }
}
