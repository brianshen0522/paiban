import { pino } from 'pino';

export type Service = 'api' | 'torrent' | 'media';

export function createLogger(service: Service) {
  return pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service } });
}
