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

  it('is called only where something a person asked for is carried out', async () => {
    // Each deletion function and the only files allowed to call it: the torrent loop for rows a person
    // marked want = remove, and the administrator's force-delete endpoint.
    const allowed: Record<string, string[]> = {
      removeDownloadFiles: ['torrent/worker.ts'],
      removePoster: ['torrent/worker.ts'],
      removePreviewFiles: ['admin/storage-delete-routes.ts'],
      removeExportFiles: ['admin/storage-delete-routes.ts'],
      removeOrphanFolder: ['admin/storage-delete-routes.ts'],
      // A holder removing a candidate or a subtitle.
      removeCandidateFiles: ['subtitles/routes.ts'],
      removeSubtitleFiles: ['subtitles/routes.ts'],
      // The listed scratch clean-ups: start-up drafts, a job's own work folder, a job's own output
      // when its final update found the row gone or cancelled, a staged upload or download once the
      // job that uses it ends.
      cleanScratchOnStart: ['media/service.ts'],
      removeWorkDir: ['media/jobs.ts', 'media/subtitle-jobs.ts', 'subtitles/routes.ts'],
      removeOwnMediaOutput: ['media/jobs.ts'],
      removeOwnSubtitleOutput: ['media/subtitle-jobs.ts', 'subtitles/routes.ts'],
      removeStaging: ['media/subtitle-jobs.ts', 'subtitles/routes.ts', 'subtitles/worker.ts'],
    };
    const exported = [
      ...(await readFile(join(SRC, 'storage/remove.ts'), 'utf8')).matchAll(/export async function (\w+)/g),
    ].map((m) => m[1]);
    expect(exported.sort()).toEqual(Object.keys(allowed).sort());
    const callers: Record<string, string[]> = {};
    for (const file of await sources(SRC)) {
      const rel = relative(SRC, file);
      if (rel === 'storage/remove.ts') continue;
      const text = await readFile(file, 'utf8');
      for (const fn of Object.keys(allowed)) {
        if (!new RegExp(`\\b${fn}\\(`).test(text)) continue;
        callers[fn] ??= [];
        callers[fn].push(rel);
      }
    }
    for (const [fn, files] of Object.entries(allowed))
      expect((callers[fn] ?? []).sort(), fn).toEqual([...files].sort());
    const worker = await readFile(join(SRC, 'torrent/worker.ts'), 'utf8');
    expect(worker).toMatch(/where t\.want = 'remove'/);
  });
});
