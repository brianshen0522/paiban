import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { AlignResult, Lang, SyncDoc } from '@paiban/shared';
import { type HeardPairs, localPairs, readTranscript, sameLanguage, sameLanguagePairs } from '../asr/align.js';
import { many, one, type Pool } from '../db/pool.js';
import { removeOwnSubtitleOutput, removeStaging, removeWorkDir } from '../storage/remove.js';
import {
  computeAlignment,
  computeReferenceAlignment,
  ffsubsyncCandidates,
  runFfsubsyncEngines,
} from '../subtitles/align.js';
import { ArchiveError, archiveKind, extractSubtitles } from '../subtitles/archive.js';
import { baseLanguage, referenceLines, referenceTranscript } from '../subtitles/reference.js';
import { candidateDir, candidateRel, readCues, type StagedFile, speechFor, stagingDir } from '../subtitles/store.js';
import { type ParsedSubtitle, parseSubtitleFile } from '../subtitles/text.js';
import type { JobDeps } from './jobs.js';

/**
 * The media service's subtitle work (docs/07-subtitle-providers.md, "Download and processing (`subtitle.resolve` downloads; `subtitle.fetch` / `subtitle.ingest` process)"; docs/08,
 * "Auto-align"): turning a staged upload or download into cues (`ingest`), aligning a candidate for
 * a ranking (`rank`), and the workbench's own alignment (`align`). Same rules as every media job:
 * a conditional claim, work in /data/tmp/work, a check right before files move into place, and a
 * conditional final update that removes what it just placed when the update finds nothing.
 */
const workDir = (dataDir: string, name: string) => join(dataDir, 'tmp', 'work', name);

async function wakeApi(pool: Pool, torrentId: string, usage: boolean): Promise<void> {
  await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'candidates', id: torrentId })]);
  if (usage) await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
}

/* ================================================================ ingest */

type IngestError = 'ARCHIVE_INVALID' | 'NO_SUBTITLE' | 'PARSE_FAILED' | 'DOWNLOAD_FAILED';
class IngestFailure extends Error {
  readonly code: IngestError;
  constructor(code: IngestError) {
    super(code);
    this.code = code;
  }
}

/** Whether a candidate has something staged for the media service. */
export async function isStaged(dataDir: string, candidateId: string): Promise<boolean> {
  return stat(join(stagingDir(dataDir, candidateId), 'manifest.json')).then(
    () => true,
    () => false,
  );
}

async function head(path: string): Promise<Buffer> {
  const f = await open(path, 'r');
  try {
    const buf = Buffer.alloc(8);
    const { bytesRead } = await f.read(buf, 0, 8, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

type Item = { name: string; bytes: Buffer; parsed: ParsedSubtitle; fromArchive: boolean };

/** Which file the original candidate stands for: the first in the chosen languages, else by name (docs/07, step 9). */
export function primaryOrder(items: { name: string; language: string }[], languages: readonly Lang[] | null): number[] {
  const rank = (l: string) => {
    if (!languages) return 0;
    const i = languages.findIndex((x) => x === l || (l === 'zh' && (x === 'zh-Hant' || x === 'zh-Hans')));
    return i < 0 ? languages.length : i;
  };
  return items
    .map((it, i) => ({ i, r: rank(it.language), name: it.name }))
    .sort((a, b) => a.r - b.r || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((x) => x.i);
}

export async function ingestJob(d: JobDeps, candidateId: string): Promise<void> {
  const { pool, config } = d;
  const c = await one<{
    torrent_id: string;
    provider: string;
    provider_ref: string;
    language_label: string;
    release_name: string;
    flags: Record<string, unknown>;
  }>(
    pool,
    `select c.torrent_id, c.provider, c.provider_ref, c.language_label, c.release_name, c.flags
       from subtitle_candidates c join torrents t on t.id = c.torrent_id
      where c.id = $1 and c.fetch_state = 'fetching' and t.want <> 'remove'`,
    [candidateId],
  );
  if (!c || !(await isStaged(config.dataDir, candidateId))) return;
  const staging = stagingDir(config.dataDir, candidateId);
  const work = workDir(config.dataDir, `ingest-${candidateId}`);
  const placed: { id: string; primary: boolean }[] = [];
  try {
    await mkdir(work, { recursive: true });
    const manifest = JSON.parse(await readFile(join(staging, 'manifest.json'), 'utf8')) as StagedFile[];
    // Files to read: subtitle files as they are, and the subtitle entries of archives (step 2: by their first bytes).
    const files: { name: string; path: string; fromArchive: boolean }[] = [];
    let archives = 0;
    for (const [i, m] of manifest.entries()) {
      const path = join(staging, m.file);
      if (archiveKind(await head(path))) {
        archives++;
        const into = join(work, `x${i}`);
        await mkdir(into, { recursive: true });
        try {
          for (const e of await extractSubtitles(path, into))
            files.push({ name: e.name, path: e.path, fromArchive: true });
        } catch (err) {
          if (err instanceof ArchiveError) throw new IngestFailure(err.code);
          throw err;
        }
      } else files.push({ name: m.name, path, fromArchive: false });
    }
    if (files.length === 0) throw new IngestFailure(archives ? 'NO_SUBTITLE' : 'DOWNLOAD_FAILED');
    const items: Item[] = [];
    for (const f of files) {
      const bytes = await readFile(f.path);
      const parsed = parseSubtitleFile(f.name, bytes);
      if (parsed) items.push({ name: f.name, bytes, parsed, fromArchive: f.fromArchive });
    }
    if (items.length === 0) throw new IngestFailure('PARSE_FAILED');

    const search =
      c.provider === 'upload'
        ? null
        : await one<{ languages: Lang[] }>(
            pool,
            'select languages from subtitle_searches where torrent_id = $1 and provider = $2',
            [c.torrent_id, c.provider],
          );
    const order = primaryOrder(
      items.map((it) => ({ name: it.name, language: it.parsed.language })),
      search?.languages.length ? search.languages : null,
    );

    // Step 8: everything prepared in the work folder first.
    const prepared: { dir: string; item: Item; bytes: number }[] = [];
    for (const [k, idx] of order.entries()) {
      const item = items[idx] as Item;
      const dir = join(work, `out-${k}`);
      await mkdir(dir, { recursive: true });
      const ext = (extname(item.name).slice(1).toLowerCase() || item.parsed.format).replace(/[^a-z0-9]/g, '') || 'srt';
      await writeFile(join(dir, `original.${ext}`), item.bytes);
      const cuesJson = JSON.stringify(item.parsed.cues);
      await writeFile(join(dir, 'cues.json'), cuesJson);
      prepared.push({ dir, item, bytes: item.bytes.length + Buffer.byteLength(cuesJson) });
    }
    const flagsOf = (it: Item) => ({
      archive: it.fromArchive || !!c.flags.archive,
      ass: it.parsed.format === 'ass',
      bilingual: it.parsed.bilingual,
      convertedFrom: it.parsed.encoding === 'utf-8' ? null : it.parsed.encoding,
    });
    const baseName = (n: string) => n.split('/').pop() ?? n;

    const stillWanted = await one(
      pool,
      `select 1 from subtitle_candidates c join torrents t on t.id = c.torrent_id
        where c.id = $1 and c.fetch_state = 'fetching' and t.want <> 'remove'`,
      [candidateId],
    );
    if (!stillWanted) return;
    await mkdir(join(config.dataDir, 'subtitles', 'candidates'), { recursive: true });

    const [first, ...rest] = prepared;
    if (!first) throw new IngestFailure('PARSE_FAILED');
    await removeOwnSubtitleOutput(config.dataDir, 'candidate', candidateId); // a leftover from an earlier, interrupted try
    await rename(first.dir, candidateDir(config.dataDir, candidateId));
    placed.push({ id: candidateId, primary: true });
    const fin = await pool.query(
      `update subtitle_candidates c set fetch_state = 'ready', fetch_error = null, language = $2, cue_count = $3, bytes = $4,
              detected_encoding = $5, rel_dir = $6, flags = c.flags || $7::jsonb,
              release_name = case when c.provider = 'upload' and $8::boolean then $9 else c.release_name end
         from torrents t
        where c.id = $1 and c.fetch_state = 'fetching' and t.id = c.torrent_id and t.want <> 'remove'`,
      [
        candidateId,
        first.item.parsed.language,
        first.item.parsed.cues.length,
        first.bytes,
        first.item.parsed.encoding,
        candidateRel(candidateId),
        flagsOf(first.item),
        first.item.fromArchive,
        baseName(first.item.name),
      ],
    );
    if (!fin.rowCount) {
      // Removed, or the film is being removed, while this ran: take back what was just placed.
      await removeOwnSubtitleOutput(config.dataDir, 'candidate', candidateId);
      return;
    }
    // Step 9: the other files of the same download each become a candidate of their own.
    for (const p of rest) {
      const id = randomUUID();
      await rename(p.dir, candidateDir(config.dataDir, id));
      const ins = await pool.query(
        `insert into subtitle_candidates (id, torrent_id, provider, provider_ref, language_label, language, release_name, fetch_state,
                                          fetch_started_at, rel_dir, bytes, detected_encoding, cue_count, flags)
         select $1, t.id, $3, $4, $5, $6, $7, 'ready', now(), $8, $9, $10, $11, $12
           from torrents t where t.id = $2 and t.want <> 'remove'
         on conflict (torrent_id, provider, provider_ref) do nothing`,
        [
          id,
          c.torrent_id,
          c.provider,
          `${c.provider_ref}#${p.item.name}`,
          c.language_label,
          p.item.parsed.language,
          baseName(p.item.name),
          candidateRel(id),
          p.bytes,
          p.item.parsed.encoding,
          p.item.parsed.cues.length,
          flagsOf(p.item),
        ],
      );
      if (!ins.rowCount) await removeOwnSubtitleOutput(config.dataDir, 'candidate', id);
    }
    await wakeApi(pool, c.torrent_id, true);
  } catch (err) {
    const code: IngestError = err instanceof IngestFailure ? err.code : 'PARSE_FAILED';
    if (!(err instanceof IngestFailure)) d.log.warn({ err, candidateId }, 'subtitle processing failed unexpectedly');
    const r = await pool.query(
      `update subtitle_candidates set fetch_state = 'failed', fetch_error = $2,
              align_state = case when align_state in ('queued', 'running') then 'failed' else align_state end
        where id = $1 and fetch_state = 'fetching'`,
      [candidateId, code],
    );
    if (r.rowCount && placed.some((p) => p.primary))
      await removeOwnSubtitleOutput(config.dataDir, 'candidate', candidateId);
    await wakeApi(pool, c.torrent_id, false);
  } finally {
    await removeWorkDir(config.dataDir, work);
    await removeStaging(config.dataDir, candidateId);
  }
}

/* ================================================================ alignment */

/**
 * ffsubsync's candidates, the core's, and recognised speech's (docs/08, "Steps", "Speech recognition"), for
 * one cue list. `given` are pairs the api already made with the language model; otherwise a
 * subtitle in the spoken language is paired by text here. Ranking never asks a language model:
 * thirty candidates would cost thirty requests.
 */
async function align(
  d: JobDeps,
  mediaId: string,
  speech: Parameters<typeof computeAlignment>[0],
  sub: { relDir: string; language: string },
  opts: { allowSplit: boolean; before?: SyncDoc; given?: HeardPairs | null },
  work: string,
  isCancelled: () => boolean,
): Promise<AlignResult> {
  const cues = await readCues(d.config.dataDir, sub.relDir);
  await mkdir(work, { recursive: true });
  const refNpz = join(d.config.dataDir, 'media', mediaId, 'ref.npz');
  const outputs = await runFfsubsyncEngines(refNpz, cues, opts.allowSplit, work, isCancelled);
  const extra = ffsubsyncCandidates(speech, cues, outputs);
  const heard =
    opts.given && opts.given.via !== 'none'
      ? opts.given
      : (localPairs(cues, await readTranscript(d.config.dataDir, mediaId), sub.language) ?? opts.given ?? null);
  // A failed request to the model is still worth reporting when nothing else was found.
  const withError =
    heard && opts.given?.llmError && heard.via === 'none' ? { ...heard, llmError: opts.given.llmError } : heard;
  return computeAlignment(speech, cues, { ...opts, heard: withError }, extra);
}

/** Polls `check` every two seconds while `fn` runs; the flag tells the job to stop (docs/08, "check every 2 seconds while running"). */
async function whileWanted<T>(
  check: () => Promise<boolean>,
  fn: (isCancelled: () => boolean) => Promise<T>,
): Promise<T> {
  let cancelled = false;
  const timer = setInterval(() => {
    void check().then(
      (ok) => {
        if (!ok) cancelled = true;
      },
      () => undefined,
    );
  }, 2000);
  try {
    return await fn(() => cancelled);
  } finally {
    clearInterval(timer);
  }
}

/** One candidate of a ranking run (`subtitle.rank`). A failure is that candidate's result, not the run's. */
export async function rankJob(d: JobDeps, candidateId: string): Promise<void> {
  const { pool, config } = d;
  const claimed = await one<{ torrent_id: string; rel_dir: string; language: string }>(
    pool,
    `update subtitle_candidates c set align_state = 'running' from torrents t
      where c.id = $1 and c.align_state = 'queued' and c.fetch_state = 'ready' and t.id = c.torrent_id and t.want <> 'remove'
      returning c.torrent_id, c.rel_dir, c.language`,
    [candidateId],
  );
  if (!claimed) return;
  await pool.query(
    `update tasks set state = 'running', started_at = coalesce(started_at, now()) where kind = 'rank' and torrent_id = $1 and state = 'queued'`,
    [claimed.torrent_id],
  );
  const work = workDir(config.dataDir, `rank-${candidateId}`);
  try {
    const sp = await speechFor(pool, config.dataDir, claimed.torrent_id);
    if (!sp) throw new Error('no speech data');
    const result = await whileWanted(
      async () =>
        !!(await one(
          pool,
          `select 1 from subtitle_candidates c join torrents t on t.id = c.torrent_id
            where c.id = $1 and c.align_state = 'running' and t.want <> 'remove'`,
          [candidateId],
        )),
      (isCancelled) =>
        align(
          d,
          sp.mediaId,
          sp.speech,
          { relDir: claimed.rel_dir, language: claimed.language },
          { allowSplit: true },
          work,
          isCancelled,
        ),
    );
    await pool.query(
      `update subtitle_candidates set align_state = 'done', align_score = $2, align_result = $3 where id = $1 and align_state = 'running'`,
      [candidateId, result.score, result],
    );
  } catch (err) {
    d.log.info({ candidateId, err: err instanceof Error ? err.message : 'failed' }, 'ranking alignment failed');
    await pool.query(
      `update subtitle_candidates set align_state = 'failed' where id = $1 and align_state = 'running'`,
      [candidateId],
    );
  } finally {
    await removeWorkDir(config.dataDir, work);
  }
  await settleRanks(pool);
  await wakeApi(pool, claimed.torrent_id, false);
}

/**
 * The workbench's "Auto-align" (`subtitle.align`): the answer goes into tasks.result for the api that
 * is waiting. Not retried; an alignment the api stopped waiting for finds its task no longer running.
 */
export async function alignJob(d: JobDeps, taskId: string): Promise<void> {
  const { pool, config } = d;
  const t = await one<{
    input: { subtitleId?: string; allowSplit?: boolean; heard?: HeardPairs | null; referenceId?: string };
  }>(
    pool,
    `update tasks set state = 'running', started_at = now() where id = $1 and kind = 'align' and state = 'queued' returning input`,
    [taskId],
  );
  if (!t) return;
  await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'task', id: taskId })]);
  const work = workDir(config.dataDir, `align-${taskId}`);
  let code = 'ALIGN_FAILED';
  try {
    const s = await one<{ torrent_id: string; rel_dir: string; doc: SyncDoc; language: string }>(
      pool,
      `select s.torrent_id, s.rel_dir, s.doc, s.language from subtitles s join torrents t on t.id = s.torrent_id
        where s.id = $1 and t.want <> 'remove'`,
      [t.input.subtitleId],
    );
    if (!s) {
      code = 'SUBJECT_GONE';
      throw new Error('subtitle gone');
    }
    const sp = await speechFor(pool, config.dataDir, s.torrent_id);
    if (t.input.referenceId) {
      // Aligning to another subtitle of the same film (docs/08, "Align by other subtitles"): no sound needed.
      const ref = await one<{ rel_dir: string; doc: SyncDoc; language: string }>(
        pool,
        'select rel_dir, doc, language from subtitles where id = $1 and torrent_id = $2',
        [t.input.referenceId, s.torrent_id],
      );
      if (!ref) {
        code = 'SUBJECT_GONE';
        throw new Error('reference gone');
      }
      const cues = await readCues(config.dataDir, s.rel_dir);
      const lines = referenceLines(await readCues(config.dataDir, ref.rel_dir), ref.doc);
      // Same language: paired by text, free and instant. Another language: the timing of the
      // reference's lines alone, which measured as precise as the model's pairs at a fraction of the time.
      const pairs = sameLanguage(s.language, baseLanguage(ref.language))
        ? sameLanguagePairs(cues, referenceTranscript(lines, ref.language))
        : [];
      const result = computeReferenceAlignment({ subtitleId: t.input.referenceId, lines }, cues, {
        allowSplit: t.input.allowSplit !== false,
        before: s.doc,
        pairs: pairs.length ? { language: baseLanguage(ref.language), pairs, via: 'text', llmError: null } : null,
        filmSpeech: sp?.speech ?? null,
      });
      await pool.query(
        `update tasks set state = 'done', result = $2, progress = 1, finished_at = now() where id = $1 and state = 'running'`,
        [taskId, result],
      );
      await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'task', id: taskId })]);
      return;
    }
    if (!sp) {
      code = 'NO_SPEECH';
      throw new Error('no speech data');
    }
    const result = await whileWanted(
      async () => !!(await one(pool, `select 1 from tasks where id = $1 and state = 'running'`, [taskId])),
      (isCancelled) =>
        align(
          d,
          sp.mediaId,
          sp.speech,
          { relDir: s.rel_dir, language: s.language },
          { allowSplit: t.input.allowSplit !== false, before: s.doc, given: t.input.heard ?? null },
          work,
          isCancelled,
        ),
    );
    await pool.query(
      `update tasks set state = 'done', result = $2, progress = 1, finished_at = now() where id = $1 and state = 'running'`,
      [taskId, result],
    );
  } catch (err) {
    d.log.info({ taskId, err: err instanceof Error ? err.message : 'failed' }, 'alignment failed');
    await pool.query(
      `update tasks set state = 'failed', error_code = $2, finished_at = now() where id = $1 and state = 'running'`,
      [taskId, code],
    );
  } finally {
    await removeWorkDir(config.dataDir, work);
  }
  await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'task', id: taskId })]);
}

/* ================================================================ reconciliation */

/**
 * Progress of every unfinished ranking (docs/08, "Reconciliation" item 2): of its candidates that still
 * exist, how many have a result. When all of them do, the run is done. Candidates removed or
 * replaced meanwhile do not count.
 */
export async function settleRanks(pool: Pool): Promise<void> {
  const runs = await many<{ id: string; torrent_id: string | null; input: { candidateIds?: string[] } }>(
    pool,
    `select id, torrent_id, input from tasks where kind = 'rank' and state in ('queued', 'running')`,
  );
  for (const r of runs) {
    const ids = r.input.candidateIds ?? [];
    const c = await one<{ total: number; finished: number }>(
      pool,
      `select count(*)::int as total,
              count(*) filter (where align_state in ('done', 'failed') or fetch_state = 'failed')::int as finished
         from subtitle_candidates where id = any($1::uuid[])`,
      [ids],
    );
    const total = c?.total ?? 0;
    const finished = c?.finished ?? 0;
    const done = finished >= total;
    const upd = await pool.query(
      `update tasks set progress = $2, state = case when $3 then 'done' else state end,
              finished_at = case when $3 then now() else finished_at end
        where id = $1 and state in ('queued', 'running') and (progress <> $2 or $3)`,
      [r.id, total ? finished / total : 1, done],
    );
    if (upd.rowCount) {
      await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'task', id: r.id })]);
      if (r.torrent_id) await wakeApi(pool, r.torrent_id, false);
    }
  }
}

/**
 * Candidates stuck in 'fetching' for 10 minutes (docs/08, "Reconciliation" item 3): the program handling them
 * was restarted. A state change only; their staged files, if any, are removed at the next start.
 */
export async function failStuckFetches(pool: Pool): Promise<void> {
  const rows = await many<{ torrent_id: string }>(
    pool,
    `update subtitle_candidates set fetch_state = 'failed', fetch_error = 'DOWNLOAD_FAILED',
            align_state = case when align_state in ('queued', 'running') then 'failed' else align_state end
      where fetch_state = 'fetching' and fetch_started_at < now() - interval '10 minutes'
      returning torrent_id`,
  );
  for (const t of new Set(rows.map((r) => r.torrent_id))) await wakeApi(pool, t, false);
}

/** Start-up: staged files whose candidate is no longer waiting for them (removed, failed, or done). In-flight `.part` downloads are the api's. */
export async function cleanStagingOnStart(d: JobDeps): Promise<void> {
  const base = join(d.config.dataDir, 'tmp', 'uploads');
  const names = await readdir(base).catch(() => [] as string[]);
  const ids = names.filter((n) => /^[0-9a-f-]{36}$/.test(n));
  if (!ids.length) return;
  const waiting = new Set(
    (
      await many<{ id: string }>(
        d.pool,
        `select id::text from subtitle_candidates where id = any($1::uuid[]) and fetch_state = 'fetching'`,
        [ids],
      )
    ).map((r) => r.id),
  );
  for (const id of ids) if (!waiting.has(id)) await removeStaging(d.config.dataDir, id);
}
