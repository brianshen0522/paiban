import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { removePoster } from '../src/storage/remove.js';

/** A film's poster copies go with it: the one kept when it was added and each country's (Brian, 2026-10-10). */
describe('removing a film’s posters', () => {
  it('removes its copies for every country and nothing else', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'paiban-posters-'));
    const dir = join(dataDir, 'posters');
    await mkdir(dir);
    for (const f of ['12.jpg', '12-TW.jpg', '12-JP.png', '123.jpg', 'tmdb-12-US.webp', 'tmdb-7.jpg', 'tmdb-7-KR.jpg'])
      await writeFile(join(dir, f), 'x');
    await removePoster(dataDir, 'posters/12.jpg');
    expect((await readdir(dir)).sort()).toEqual(['123.jpg', 'tmdb-12-US.webp', 'tmdb-7-KR.jpg', 'tmdb-7.jpg']);
    await removePoster(dataDir, 'posters/tmdb-7.jpg');
    expect((await readdir(dir)).sort()).toEqual(['123.jpg', 'tmdb-12-US.webp']);
    await removePoster(dataDir, '../etc/passwd');
    expect((await readdir(dir)).sort()).toEqual(['123.jpg', 'tmdb-12-US.webp']);
  });
});
