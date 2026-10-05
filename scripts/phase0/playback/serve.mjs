#!/usr/bin/env node
// Phase 0, item 7: the smallest endpoint that serves video with Range requests, plus a test page.
// Open http://<this machine>:8090/ in Chrome, Firefox and Safari and read the table it fills in.
//
//   node scripts/phase0/playback/serve.mjs [port]      (files from make-files.sh, in .scratch/playback)
//
// Range handling is what the api's streaming endpoint will do: 206 with Content-Range for a
// single range, 416 when it is outside the file, 200 for the whole file. Nothing else.
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..', '.scratch', 'playback');
const PAGE = readFileSync(join(import.meta.dirname, 'index.html'));
const FILES = new Set(['yts-like.stereo.mp4', 'yts-like.5.1.mp4']);
const port = Number(process.argv[2] ?? 8090);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }
  const name = url.pathname.slice(1);
  if (!FILES.has(name)) {
    res.writeHead(404);
    return res.end();
  }
  const file = join(ROOT, name);
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  const common = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (!range) {
    res.writeHead(200, { ...common, 'Content-Length': size });
    return createReadStream(file).pipe(res);
  }
  let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
  let end = range[1] === '' || range[2] === '' ? size - 1 : Number(range[2]);
  end = Math.min(end, size - 1);
  if (Number.isNaN(start) || start < 0) start = 0;
  if (start > end || start >= size) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}` });
    return res.end();
  }
  console.log(`${req.socket.remoteAddress} ${name} bytes=${start}-${end}`);
  res.writeHead(206, {
    ...common,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${size}`,
  });
  createReadStream(file, { start, end }).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`http://0.0.0.0:${port}/`));
