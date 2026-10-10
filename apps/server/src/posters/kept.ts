import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { POSTER_REGIONS } from '@paiban/shared';
import { z } from 'zod';

/**
 * Poster copies kept under /data/posters (docs/05-yts.md, "海報"), one per country someone asked
 * for (Brian, 2026-10-10): `<stem>-<region>.<ext>`, beside the copy kept when the film was added
 * (`<stem>.jpg`, Taiwan's). `<stem>` is the YTS id, or `tmdb-<id>` for a film added by hand.
 * Not counted toward the limit; removed with the film (storage/remove.ts, removePoster).
 */
export const RegionQuery = z.object({ region: z.enum(POSTER_REGIONS).default('TW') });

const TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;
type Ext = keyof typeof TYPES;
const EXTS = Object.keys(TYPES) as Ext[];

export const postersDir = (dataDir: string) => join(dataDir, 'posters');

/** A kept copy by its stem, with its media type; null when there is none. */
export async function keptPoster(dataDir: string, stem: string): Promise<{ path: string; type: string } | null> {
  for (const ext of EXTS) {
    const path = join(postersDir(dataDir), `${stem}.${ext}`);
    if (
      await access(path).then(
        () => true,
        () => false,
      )
    )
      return { path, type: TYPES[ext] };
  }
  return null;
}

/** Keeps one copy (written as .part, then renamed). Best effort: a failure only means fetching again. */
export async function keepPoster(dataDir: string, stem: string, image: { type: string; body: Buffer }): Promise<void> {
  const ext = EXTS.find((e) => TYPES[e] === image.type);
  if (!ext) return;
  const dir = postersDir(dataDir);
  const file = join(dir, `${stem}.${ext}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(`${file}.part`, image.body);
    await rename(`${file}.part`, file);
  } catch {
    // the next request fetches it again
  }
}
