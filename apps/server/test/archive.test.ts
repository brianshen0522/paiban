import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ArchiveError,
  archiveKind,
  checkEntries,
  extractSubtitles,
  isSubtitleEntry,
} from '../src/subtitles/archive.js';

/**
 * docs/07-subtitle-providers.md step 3 and docs/12-auth.md "上傳與壓縮檔", on fixtures/archives.
 * The extraction tests need bsdtar: it is in the image (`pnpm test:image`); without it they are
 * skipped, loudly. The rule checks run everywhere.
 */
const BSDTAR = spawnSync(process.env.BSDTAR ?? 'bsdtar', ['--version'], { stdio: 'ignore' }).status === 0;
if (!BSDTAR)
  console.warn(
    'archive.test.ts extraction SKIPPED: bsdtar not found here. Run `pnpm test:image` to run it in the image.',
  );

const fixture = (f: string) => fileURLToPath(new URL(`../../../fixtures/${f}`, import.meta.url));

describe('archive rules', () => {
  it('knows an archive by its first bytes, not its name', async () => {
    expect(archiveKind(await readFile(fixture('archive.zip')))).toBe('zip');
    expect(archiveKind(await readFile(fixture('archives/archive.rar')))).toBe('rar');
    expect(archiveKind(await readFile(fixture('archives/archive.7z')))).toBe('7z');
    expect(archiveKind(await readFile(fixture('late.zh-TW.srt')))).toBeNull();
  });

  it('takes subtitle files only', () => {
    expect(isSubtitleEntry('a/b.SRT')).toBe(true);
    expect(isSubtitleEntry('x.ssa')).toBe(true);
    expect(isSubtitleEntry('x.vtt')).toBe(true);
    for (const n of ['readme.txt', 'x.nfo', 'x.sub', 'x.idx', '__MACOSX/._x.srt', 'dir/._x.srt'])
      expect(isSubtitleEntry(n), n).toBe(false);
  });

  it('refuses links, escaping paths, too many entries and declared sizes over the limits', () => {
    const file = (name: string, size = 10) => ({ name, type: '-', size });
    const bad = [
      [{ name: 'link.srt', type: 'l', size: 0 }],
      [{ name: 'hard.srt', type: 'h', size: 0 }],
      [file('/tmp/absolute.srt')],
      [file('../../escaped.srt')],
      [file('a/../../b.srt')],
      [file('C:/x.srt')],
      Array.from({ length: 201 }, (_, i) => file(`${i}.srt`)),
      [file('big.srt', 10 * 1024 * 1024 + 1)],
      Array.from({ length: 6 }, (_, i) => file(`${i}.srt`, 9 * 1024 * 1024)),
    ];
    for (const entries of bad) expect(() => checkEntries(entries)).toThrow(ArchiveError);
    expect(() => checkEntries([file('ok.srt'), { name: 'dir', type: 'd', size: 0 }, file('a..b.srt')])).not.toThrow();
  });
});

describe.skipIf(!BSDTAR)('extracting with bsdtar', () => {
  const work = async () => mkdtemp(join(tmpdir(), 'paiban-archive-'));

  it.each(['archive.zip', 'archives/archive.rar', 'archives/archive.7z'])(
    '%s gives the two subtitles, byte for byte',
    async (a) => {
      const dir = await work();
      const out = await extractSubtitles(fixture(a), dir);
      expect(out.map((e) => e.name).sort()).toEqual([
        'Sample.Movie.2020.1080p.BluRay.x264.YIFY.cht.srt',
        'Sample.Movie.2020.1080p.BluRay.x264.YIFY.eng.srt',
      ]);
      for (const e of out) {
        expect(e.path.startsWith(dir)).toBe(true);
        expect((await readFile(e.path)).length).toBe(e.bytes);
      }
      expect((await readdir(dir)).sort()).toEqual(['0.srt', '1.srt']);
    },
  );

  it.each([
    'hostile.traversal.zip',
    'hostile.absolute.zip',
    'hostile.symlink.zip',
    'hostile.bomb.zip',
    'hostile.many.zip',
    'broken.zip',
  ])('%s is refused whole and leaves nothing behind', async (a) => {
    const dir = await work();
    const err = await extractSubtitles(fixture(`archives/${a}`), dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ArchiveError);
    expect((err as ArchiveError).code).toBe('ARCHIVE_INVALID');
    expect(await readdir(dir)).toEqual([]);
  });

  it('says NO_SUBTITLE for an archive without one', async () => {
    const err = await extractSubtitles(fixture('archives/nosubtitle.zip'), await work()).catch((e: unknown) => e);
    expect((err as ArchiveError).code).toBe('NO_SUBTITLE');
  });
});
