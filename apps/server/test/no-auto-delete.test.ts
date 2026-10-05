import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * AGENTS.md rule 1 and docs/15-testing.md, "不自動刪除": only storage/remove.ts deletes under /data
 * (WebTorrent's destroyStore included), and no deletion is decided by time or age.
 */
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await sources(p)));
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name) && !/\.d\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

const DELETES =
  /\b(rm|rmdir|unlink|rmSync|rmdirSync|unlinkSync)\s*\(|destroyStore:\s*true|removeAndDeleteFiles\s*\(|\.remove\(\s*[^)]*destroyStore/;

describe('deleting files', () => {
  it('happens only in the deletion module (and the WebTorrent wrapper that it calls)', async () => {
    const offenders: string[] = [];
    for (const file of await sources(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'storage/remove.ts') continue;
      const text = await readFile(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (!DELETES.test(line)) continue;
        // The wrapper defines removeAndDeleteFiles (destroyStore: true) for remove.ts to call.
        if (
          rel === 'torrent/engine.ts' &&
          /removeAndDeleteFiles\(hash\)|destroyStore: true \}, \(err\)|removeAndDeleteFiles\(infoHash: string\)/.test(
            line,
          )
        )
          continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('is never decided by time or age', async () => {
    const text = await readFile(join(SRC, 'storage/remove.ts'), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(
      /\bDate\b|\bnow\s*\(|\b(mtime|ctime|atime|birthtime|mtimeMs|expires?|expired|older|oldest|age|ttl|interval|setInterval|setTimeout)\b/i,
    );
  });

  it('is triggered only from the torrent loop, for rows a person marked want = remove', async () => {
    const callers: string[] = [];
    for (const file of await sources(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'storage/remove.ts') continue;
      if (/removeDownloadFiles|removePoster/.test(await readFile(file, 'utf8'))) callers.push(rel);
    }
    expect(callers).toEqual(['torrent/worker.ts']);
    const worker = await readFile(join(SRC, 'torrent/worker.ts'), 'utf8');
    expect(worker).toMatch(/where t\.want = 'remove'/);
  });
});
