import { statfs } from 'node:fs/promises';

/** Size and free space of the filesystem holding /data. A function so tests can pretend a disk is full. */
export type DiskProbe = () => Promise<{ totalBytes: number; availableBytes: number }>;

export function diskProbe(dataDir: string): DiskProbe {
  return async () => {
    const s = await statfs(dataDir);
    return { totalBytes: s.blocks * s.bsize, availableBytes: s.bavail * s.bsize };
  };
}
