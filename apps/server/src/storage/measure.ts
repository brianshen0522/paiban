import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Bytes a folder really occupies (allocated blocks: partial torrent files are sparse). 0 if missing. */
export async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await folderBytes(p);
    else if (e.isFile()) {
      const s = await lstat(p);
      total += Math.min(s.size, s.blocks * 512);
    }
  }
  return total;
}
