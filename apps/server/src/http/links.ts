import type { FastifyRequest } from 'fastify';

/**
 * The start of invite and reset links. PUBLIC_URL normally; but while it still says localhost
 * (a fresh install), links built for someone on another device would not open, so the address
 * the administrator is using right now is taken instead.
 */
export function linkBase(publicUrl: string, req: FastifyRequest): string {
  const configured = new URL(publicUrl);
  const local = configured.hostname === 'localhost' || configured.hostname === '127.0.0.1';
  const origin = req.headers.origin;
  if (local && origin && /^https?:\/\//.test(origin)) {
    try {
      const o = new URL(origin);
      if (o.host === req.headers.host) return o.origin;
    } catch {
      // fall through
    }
  }
  return publicUrl.replace(/\/+$/, '');
}
