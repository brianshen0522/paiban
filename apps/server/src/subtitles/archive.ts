import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Archives from subtitle sites and uploads (docs/07-subtitle-providers.md, "Download and processing (`subtitle.resolve` downloads; `subtitle.fetch` / `subtitle.ingest` process)", step 3;
 * docs/12-auth.md, "Uploads and archives"). bsdtar from the image reads zip, 7z and RAR5, but it enforces
 * none of our limits (it extracts symlinks, any number of entries, any size: docs/agent-notes.md),
 * so the rules are ours:
 *
 *   1. list first (`bsdtar -tf` for the names, `-tvf` for types and declared sizes) and refuse the
 *      whole archive for a symlink or any non-file, an absolute path, a `..` segment, more than 200
 *      entries, a declared size over 10 MB for one file or 50 MB in all;
 *   2. extract only the subtitle entries, one at a time to stdout, counting the bytes as they come
 *      (headers can lie), and write them ourselves into the job's work folder under names we make.
 *
 * bsdtar never writes to disk here, so a hostile name or link cannot land anywhere.
 * Started with argument arrays, never a shell (docs/12-auth.md, "Running external programs").
 */

export type ArchiveLimits = { maxEntries: number; maxFileBytes: number; maxTotalBytes: number };
export const ARCHIVE_LIMITS: ArchiveLimits = {
  maxEntries: 200,
  maxFileBytes: 10 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
};

export class ArchiveError extends Error {
  readonly code: 'ARCHIVE_INVALID' | 'NO_SUBTITLE';
  constructor(code: 'ARCHIVE_INVALID' | 'NO_SUBTITLE', message: string) {
    super(message);
    this.code = code;
  }
}

/** From the first bytes, never the file name. */
export function archiveKind(head: Buffer): 'zip' | 'rar' | '7z' | null {
  if (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 3 || head[2] === 5) &&
    (head[3] === 4 || head[3] === 6)
  )
    return 'zip';
  if (head.subarray(0, 6).equals(Buffer.from('Rar!\x1a\x07', 'latin1'))) return 'rar';
  if (head.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  return null;
}

const SUBTITLE_EXT = /\.(srt|ass|ssa|vtt)$/i;

/** Entries we take: subtitle files, not macOS resource forks. `.sub`/`.idx`, `.txt`, `.nfo` are ignored. */
export function isSubtitleEntry(name: string): boolean {
  if (/(^|\/)__MACOSX\//.test(name) || basename(name).startsWith('._')) return false;
  return SUBTITLE_EXT.test(name);
}

const bsdtar = () => process.env.BSDTAR ?? 'bsdtar';
const ENV = { ...process.env, LC_ALL: 'C.UTF-8' };

/** Runs bsdtar, keeping at most `cap` bytes of stdout; over the cap the process is killed. */
function runTar(args: string[], cap: number): Promise<{ code: number | null; out: Buffer; over: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bsdtar(), args, { stdio: ['ignore', 'pipe', 'ignore'], env: ENV });
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    child.stdout.on('data', (d: Buffer) => {
      if (over) return;
      total += d.length;
      if (total > cap) {
        over = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(d);
    });
    child.on('error', () => resolve({ code: -1, out: Buffer.alloc(0), over }));
    child.on('close', (code) => resolve({ code, out: Buffer.concat(chunks), over }));
  });
}

export type ArchiveEntry = { name: string; type: string; size: number };

/** The entries as bsdtar lists them. ARCHIVE_INVALID when it cannot read the archive. */
export async function listArchive(path: string): Promise<ArchiveEntry[]> {
  const names = await runTar(['-t', '-f', path], 4 * 1024 * 1024);
  const long = await runTar(['-t', '-v', '-f', path], 4 * 1024 * 1024);
  if (names.code !== 0 || long.code !== 0) throw new ArchiveError('ARCHIVE_INVALID', 'bsdtar cannot read it');
  const n = names.out.toString('utf8').split('\n').filter(Boolean);
  const l = long.out.toString('utf8').split('\n').filter(Boolean);
  if (n.length !== l.length) throw new ArchiveError('ARCHIVE_INVALID', 'listing does not line up');
  return n.map((name, i) => {
    const m = /^(\S)\S{9}\s+\d+\s+\S+\s+\S+\s+(\d+)\s/.exec(l[i] as string);
    if (!m) throw new ArchiveError('ARCHIVE_INVALID', 'unreadable listing line');
    return { name, type: m[1] as string, size: Number(m[2]) };
  });
}

/** Rule 1 above: throws ARCHIVE_INVALID with the reason. */
export function checkEntries(entries: ArchiveEntry[], limits: ArchiveLimits = ARCHIVE_LIMITS): void {
  if (entries.length > limits.maxEntries) throw new ArchiveError('ARCHIVE_INVALID', `${entries.length} entries`);
  let total = 0;
  for (const e of entries) {
    if (e.type !== '-' && e.type !== 'd') throw new ArchiveError('ARCHIVE_INVALID', `entry of type ${e.type}`);
    if (e.name.startsWith('/') || /^[A-Za-z]:/.test(e.name) || e.name.split(/[/\\]/).includes('..'))
      throw new ArchiveError('ARCHIVE_INVALID', 'entry path leaves the folder');
    if (e.size > limits.maxFileBytes) throw new ArchiveError('ARCHIVE_INVALID', 'entry over the size limit');
    total += e.size;
  }
  if (total > limits.maxTotalBytes) throw new ArchiveError('ARCHIVE_INVALID', 'archive over the size limit');
}

/** bsdtar takes member names as patterns; escape the pattern characters so a name means itself. */
const literal = (name: string) => name.replace(/[\\*?[\]]/g, (c) => `\\${c}`);

export type Extracted = { name: string; path: string; bytes: number };

/**
 * The subtitle files of an archive, written to `workDir` as `<n>.<ext>`. NO_SUBTITLE when it opens
 * but has none; ARCHIVE_INVALID for anything against the rules.
 */
export async function extractSubtitles(
  archivePath: string,
  workDir: string,
  limits: ArchiveLimits = ARCHIVE_LIMITS,
): Promise<Extracted[]> {
  const entries = await listArchive(archivePath);
  checkEntries(entries, limits);
  const wanted = entries.filter((e) => e.type === '-' && isSubtitleEntry(e.name));
  if (wanted.length === 0) throw new ArchiveError('NO_SUBTITLE', 'no subtitle file inside');
  const out: Extracted[] = [];
  let total = 0;
  for (const [i, e] of wanted.entries()) {
    const r = await runTar(['-x', '-O', '-f', archivePath, '--', literal(e.name)], limits.maxFileBytes);
    if (r.over) throw new ArchiveError('ARCHIVE_INVALID', 'entry larger than declared');
    if (r.code !== 0) throw new ArchiveError('ARCHIVE_INVALID', 'entry cannot be extracted');
    total += r.out.length;
    if (total > limits.maxTotalBytes) throw new ArchiveError('ARCHIVE_INVALID', 'archive larger than declared');
    const ext = (e.name.match(SUBTITLE_EXT)?.[1] ?? 'srt').toLowerCase();
    const path = join(workDir, `${i}.${ext}`);
    await writeFile(path, r.out);
    out.push({ name: e.name, path, bytes: r.out.length });
  }
  return out;
}
