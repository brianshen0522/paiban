import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from './errors.js';

/** `attachment` header value with an ASCII fallback and the UTF-8 name (RFC 6266, RFC 8187). */
export function attachment(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Streams a file with Range support (docs/04-api.md, "Videos": Range, If-Range, HEAD, Accept-Ranges,
 * no caching). The path always comes from the database, never from the request. With
 * `downloadName` the browser saves it instead of showing it.
 */
export async function sendFile(
  req: FastifyRequest,
  reply: FastifyReply,
  path: string,
  mime: string,
  opts: { downloadName?: string } = {},
): Promise<FastifyReply> {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) throw new ApiError('NOT_FOUND', 'file not there');
  const size = s.size;
  const etag = `"${s.mtimeMs.toString(36)}-${size.toString(36)}"`;
  reply
    .header('Accept-Ranges', 'bytes')
    .header('Cache-Control', 'private, no-store')
    .header('ETag', etag)
    .header('Last-Modified', s.mtime.toUTCString())
    .type(mime);
  if (opts.downloadName) reply.header('Content-Disposition', attachment(opts.downloadName));
  const range = req.headers.range;
  const ifRange = req.headers['if-range'];
  const rangeApplies = range && (!ifRange || ifRange === etag || ifRange === s.mtime.toUTCString());
  const m = rangeApplies ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (!m) return reply.header('Content-Length', size).send(req.method === 'HEAD' ? '' : createReadStream(path));
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
  let end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start < 0) start = 0;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    return reply.status(416).header('Content-Range', `bytes */${size}`).send();
  }
  end = Math.min(end, size - 1);
  reply
    .status(206)
    .header('Content-Range', `bytes ${start}-${end}/${size}`)
    .header('Content-Length', end - start + 1);
  return reply.send(req.method === 'HEAD' ? '' : createReadStream(path, { start, end }));
}
