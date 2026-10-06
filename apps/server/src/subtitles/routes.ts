import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  type AlignResult,
  CHECKPOINT_COUNT,
  type Cue,
  type Lang,
  type ProviderId,
  type Subtitle,
  SyncCore,
  type SyncDoc,
  UPLOAD_MAX_BYTES,
} from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { llmHeard } from '../asr/align.js';
import { audit } from '../audit.js';
import { AttemptLimiter } from '../auth/ratelimit.js';
import { prefsOf } from '../auth/users.js';
import { one, pgCode, tx, UNIQUE_VIOLATION } from '../db/pool.js';
import { NOTIFICATION_JSON, publishCandidates, publishSubtitle } from '../events/publish.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { readSettings } from '../settings/settings.js';
import {
  removeCandidateFiles,
  removeOwnSubtitleOutput,
  removeStaging,
  removeSubtitleFiles,
  removeWorkDir,
} from '../storage/remove.js';
import { holderTorrent } from '../torrents/routes.js';
import type { TorrentRow } from '../torrents/view.js';
import { PROVIDER_ORDER, type ProviderKey } from './providers/index.js';
import {
  type CandidateRow,
  candidateDir,
  candidateList,
  candidateRow,
  candidateRows,
  coveredLanguages,
  preRankOrder,
  readCues,
  type StagedFile,
  type SubtitleRow,
  speechFor,
  stagingDir,
  subtitleDir,
  subtitleRel,
  subtitleRow,
  subtitleRows,
  toSubtitle,
} from './store.js';
import { cuesToTraditional } from './text.js';
import { SubtitleWorker } from './worker.js';

/**
 * The subtitle endpoints (docs/04-api.md, "字幕"; docs/07-subtitle-providers.md). Every one checks
 * that the caller holds the film the subtitle or candidate belongs to; administrators are no
 * exception (docs/12-auth.md, "誰能做什麼").
 */
const IdParams = z.object({ id: z.uuid() });
const Langs = z
  .array(z.enum(['zh-Hant', 'zh-Hans', 'en']))
  .min(1)
  .max(3);
const UPLOAD_EXT = /\.(srt|ass|ssa|vtt|zip|rar|7z)$/i;
const ADD_WAIT_MS = 30_000;
const ALIGN_WAIT_MS = 60_000;

declare module 'fastify' {
  interface FastifyInstance {
    subtitleWorker: SubtitleWorker;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ms3 = (v: number) => Math.round(v * 1000) / 1000;

/* ---------------------------------------------------------------- the sync document */

const Edit = z
  .object({
    dStart: z.number().finite().optional(),
    dEnd: z.number().finite().optional(),
    text: z.string().max(2000).optional(),
    deleted: z.boolean().optional(),
  })
  .strict();
const DocSchema = z
  .object({
    v: z.literal(1),
    segments: z
      .array(
        z
          .object({
            from: z.number().int().min(0),
            scale: z.number().min(0.5).max(2),
            offset: z.number().finite().min(-86_400).max(86_400),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    edits: z.record(z.string().regex(/^\d+$/), Edit),
    anchors: z.array(z.object({ cue: z.number().int().min(0), t: z.number().finite() }).strict()).max(1000),
    checkpoints: z
      .array(z.object({ cue: z.number().int().min(0), status: z.enum(['todo', 'ok', 'bad']) }).strict())
      .max(1000),
  })
  .strict();

/** The document as stored: times rounded to the millisecond, checked against the cue list it applies to. */
export function cleanDoc(raw: unknown, cueCount: number): SyncDoc {
  const doc = parse(DocSchema, raw);
  const fields: Record<string, string> = {};
  if (doc.segments[0]?.from !== 0) fields['doc.segments'] = 'FIRST_FROM_ZERO';
  if (doc.segments.some((s, i) => i > 0 && s.from <= (doc.segments[i - 1]?.from ?? 0)))
    fields['doc.segments'] = 'NOT_INCREASING';
  if (doc.segments.some((s) => s.from >= cueCount)) fields['doc.segments'] = 'OUT_OF_RANGE';
  if (Object.keys(doc.edits).some((k) => Number(k) < 1 || Number(k) > cueCount)) fields['doc.edits'] = 'OUT_OF_RANGE';
  if (doc.anchors.some((a) => a.cue >= cueCount)) fields['doc.anchors'] = 'OUT_OF_RANGE';
  if (doc.checkpoints.some((c) => c.cue >= cueCount)) fields['doc.checkpoints'] = 'OUT_OF_RANGE';
  if (Object.keys(fields).length)
    throw new ApiError('VALIDATION', 'the document does not fit this subtitle', { fields });
  const edits: SyncDoc['edits'] = {};
  for (const [k, e] of Object.entries(doc.edits)) {
    const x: SyncDoc['edits'][string] = {};
    if (e.dStart !== undefined) x.dStart = ms3(e.dStart);
    if (e.dEnd !== undefined) x.dEnd = ms3(e.dEnd);
    if (e.text !== undefined) x.text = e.text;
    if (e.deleted !== undefined) x.deleted = e.deleted;
    edits[k] = x;
  }
  return {
    v: 1,
    segments: doc.segments.map((s) => ({ from: s.from, scale: s.scale, offset: ms3(s.offset) })),
    edits,
    anchors: doc.anchors.map((a) => ({ cue: a.cue, t: ms3(a.t) })),
    checkpoints: doc.checkpoints.map((c) => ({ cue: c.cue, status: c.status })),
  };
}

/** Key order and empty fields do not count as a change. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Whether a save changes times or text (segments, edits): that sends a confirmed subtitle back to draft. */
export const changesTiming = (a: SyncDoc, b: SyncDoc) =>
  canonical(a.segments) !== canonical(b.segments) || canonical(a.edits) !== canonical(b.edits);

function scoreOf(speech: Parameters<typeof SyncCore.makeSpeech>[0] | null, cues: Cue[], doc: SyncDoc): number | null {
  if (!speech) return null;
  return SyncCore.round3(SyncCore.totalScore(SyncCore.makeSpeech(speech), SyncCore.applyDoc(cues, doc)));
}

const langTag = (l: string) => (l === 'zh-Hant' || l === 'zh' ? 'zh-TW' : l === 'zh-Hans' ? 'zh-CN' : l);

/* ---------------------------------------------------------------- routes */

export function subtitleRoutes(app: FastifyInstance, deps: Deps): void {
  /** Auto-align presses per person: 20 in any 10 minutes. */
  const alignLimiter = new AttemptLimiter(20, 10 * 60_000);
  const { pool, config, events } = deps;
  const worker = new SubtitleWorker(deps);
  app.decorate('subtitleWorker', worker);
  app.addHook('onClose', async () => worker.stop());

  const languagesOf = async (user: AuthedUser) => {
    const settings = await readSettings(pool);
    return { settings, prefs: prefsOf(user.prefs, settings.subtitles.defaultLangs) };
  };
  const list = async (user: AuthedUser, torrentId: string, languages?: Lang[]) => {
    const { settings, prefs } = await languagesOf(user);
    return candidateList(pool, torrentId, settings, languages ?? prefs.langs);
  };

  async function holderCandidate(user: AuthedUser, id: string): Promise<{ c: CandidateRow; t: TorrentRow }> {
    const c = await candidateRow(pool, id);
    if (!c) throw new ApiError('NOT_FOUND', 'no such candidate');
    return { c, t: await holderTorrent(deps, user, c.torrent_id) };
  }
  async function holderSubtitle(user: AuthedUser, id: string): Promise<{ s: SubtitleRow; t: TorrentRow }> {
    const s = await subtitleRow(pool, id);
    if (!s) throw new ApiError('NOT_FOUND', 'no such subtitle');
    return { s, t: await holderTorrent(deps, user, s.torrent_id) };
  }
  const changedCandidates = async (torrentId: string) => {
    await publishCandidates(pool, events, torrentId);
    // The media service settles rankings whose candidates changed.
    await pool.query(`select pg_notify('paiban_media', '{}')`);
  };

  /* -------------------------------------------------------------- candidates */

  app.get('/api/torrents/:id/candidates', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    await holderTorrent(deps, user, id);
    return list(user, id);
  });

  app.post('/api/torrents/:id/subtitle-search', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({
        languages: Langs,
        provider: z.enum(['justsubtitles', 'yify', 'assrt', 'zimuku', 'upload']).optional(),
        refresh: z.boolean().optional(),
      }),
      req.body,
    );
    await holderTorrent(deps, user, id);
    if (body.provider === 'zimuku' || body.provider === 'upload')
      throw new ApiError('VALIDATION', 'that source is not searched by the server', {
        fields: { provider: 'NOT_SEARCHABLE' },
      });
    const settings = await readSettings(pool);
    const targets = (body.provider ? [body.provider as ProviderKey] : PROVIDER_ORDER).filter(
      (p) => settings.providers[p].enabled,
    );
    for (const p of targets) {
      await pool.query(
        `insert into subtitle_searches (torrent_id, provider, state, languages, started_at)
         select $1, $2, 'running', $3, clock_timestamp() from torrents where id = $1 and want <> 'remove'
         on conflict (torrent_id, provider) do update set state = 'running', languages = excluded.languages,
           started_at = excluded.started_at, finished_at = null, error_code = null, retry_at = null`,
        [id, p, body.languages],
      );
      worker.search(id, p, !!body.refresh);
    }
    await publishCandidates(pool, events, id);
    return list(user, id, body.languages);
  });

  /** All chosen-language candidates fetched and aligned once, best score per language marked (docs/07, "全部自動對齊並排名"). */
  app.post('/api/torrents/:id/candidates/rank', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { languages } = parse(z.object({ languages: Langs }), req.body);
    const t = await holderTorrent(deps, user, id);
    if (!(await speechFor(pool, config.dataDir, id)))
      throw new ApiError('MEDIA_NOT_READY', 'no speech data for this film yet');
    const running = await one(
      pool,
      `select 1 from tasks where kind = 'rank' and torrent_id = $1 and state in ('queued', 'running')`,
      [id],
    );
    if (!running) {
      const covered = coveredLanguages(languages);
      const pick = preRankOrder(
        (await candidateRows(pool, id)).filter((c) => covered.includes(c.language) && c.fetch_state !== 'failed'),
        languages,
        { quality: t.quality, source: t.source_type },
      ).slice(0, 30);
      if (pick.length) {
        const ids = pick.map((c) => c.id);
        await tx(pool, async (c) => {
          await c.query(
            `insert into tasks (kind, torrent_id, subject, input, created_by) values ('rank', $1, $2, $3, $4)`,
            [id, { movieTitle: t.title }, { candidateIds: ids }, user.id],
          );
          await c.query(
            `update subtitle_candidates set align_state = 'queued', align_score = null, align_result = null where id = any($1::uuid[])`,
            [ids],
          );
          await c.query(
            `update subtitle_candidates set fetch_state = 'fetching', fetch_started_at = now() where id = any($1::uuid[]) and fetch_state = 'new'`,
            [ids],
          );
        });
        for (const p of new Set(pick.filter((c) => c.fetch_state === 'new').map((c) => c.provider)))
          if (p !== 'upload') worker.fetch(p);
        await pool.query(`select pg_notify('paiban_events', '{"type":"task"}')`);
        await changedCandidates(id);
      }
    }
    return list(user, id, languages);
  });

  /** One subtitle file or archive; a candidate row from the moment it arrives (docs/07, "上傳"). */
  app.post('/api/torrents/:id/uploads', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    await holderTorrent(deps, user, id);
    const file = await req.file({ limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } });
    if (!file) throw new ApiError('VALIDATION', 'no file', { fields: { file: 'REQUIRED' } });
    const name = (file.filename || 'upload').replace(/[\\/]/g, '_').slice(-200);
    if (!UPLOAD_EXT.test(name)) {
      file.file.resume();
      throw new ApiError('UNSUPPORTED_FILE', 'not a subtitle file or archive');
    }
    const bytes = await file.toBuffer();
    const sha = createHash('sha256').update(bytes).digest('hex');
    const temp = `${randomUUID()}.part`;
    const tempDir = stagingDir(config.dataDir, temp);
    await mkdir(tempDir, { recursive: true });
    await writeFile(join(tempDir, '0'), bytes);
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify([{ file: '0', name }] satisfies StagedFile[]));
    try {
      const target = await tx(pool, async (c) => {
        const live = await one(c, `select 1 from torrents where id = $1 and want <> 'remove' for share`, [id]);
        if (!live) throw new ApiError('NOT_FOUND', 'no such download');
        const existing = await one<{ id: string; fetch_state: string }>(
          c,
          `select id, fetch_state from subtitle_candidates where torrent_id = $1 and provider = 'upload' and provider_ref = $2 for update`,
          [id, sha],
        );
        // The same file again: no second row. A failed one is processed again.
        if (existing && existing.fetch_state !== 'failed') return null;
        if (existing) {
          await c.query(
            `update subtitle_candidates set fetch_state = 'fetching', fetch_started_at = now(), fetch_error = null, release_name = $2,
                    align_state = 'none', align_score = null, align_result = null where id = $1`,
            [existing.id, name],
          );
          return existing.id;
        }
        const row = await one<{ id: string }>(
          c,
          `insert into subtitle_candidates (torrent_id, provider, provider_ref, release_name, language, language_label, fetch_state,
                                            fetch_started_at, flags, created_by)
           values ($1, 'upload', $2, $3, 'und', '', 'fetching', now(), $4, $5) returning id`,
          [id, sha, name, { archive: /\.(zip|rar|7z)$/i.test(name) }, user.id],
        );
        return row?.id ?? null;
      });
      if (target) {
        await removeStaging(config.dataDir, target);
        await rename(tempDir, stagingDir(config.dataDir, target));
        await pool.query(`select pg_notify('paiban_media', '{}')`);
        await publishCandidates(pool, events, id);
      }
    } finally {
      await removeStaging(config.dataDir, temp);
    }
    return list(user, id);
  });

  /** docs/07, "加入". The candidate's file is fetched first when it was not (up to 30 s). */
  app.post('/api/candidates/:id/add', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ convertToTraditional: z.boolean().optional() }), req.body ?? {});
    let { c, t } = await holderCandidate(user, id);
    if (c.fetch_state === 'new') {
      await pool.query(
        `update subtitle_candidates set fetch_state = 'fetching', fetch_started_at = now() where id = $1 and fetch_state = 'new'`,
        [id],
      );
      if (c.provider !== 'upload') worker.fetch(c.provider);
      await publishCandidates(pool, events, c.torrent_id);
    }
    const deadline = Date.now() + ADD_WAIT_MS;
    while (c.fetch_state === 'new' || c.fetch_state === 'fetching') {
      if (Date.now() > deadline) throw new ApiError('CANDIDATE_UNAVAILABLE', 'still fetching', { reason: 'TIMEOUT' });
      await sleep(250);
      const again = await candidateRow(pool, id);
      if (!again) throw new ApiError('NOT_FOUND', 'no such candidate');
      c = again;
    }
    if (c.fetch_state === 'failed' || !c.rel_dir)
      throw new ApiError('CANDIDATE_UNAVAILABLE', 'the file cannot be used', {
        reason: c.fetch_error ?? 'DOWNLOAD_FAILED',
      });

    const { prefs } = await languagesOf(user);
    const original = await readCues(config.dataDir, c.rel_dir);
    const convert = (body.convertToTraditional ?? prefs.convertToTraditional) && c.language === 'zh-Hans';
    const cues = convert ? cuesToTraditional(original) : original;
    const cuesJson = JSON.stringify(cues);
    const sha = createHash('sha256').update(cuesJson).digest('hex');
    // Checked before anything is written, so an ordinary duplicate leaves nothing on disk.
    if (await one(pool, 'select 1 from subtitles where torrent_id = $1 and sha256 = $2', [c.torrent_id, sha]))
      throw new ApiError('SUBTITLE_DUPLICATE', 'this subtitle is already added');

    const srcDir = candidateDir(config.dataDir, c.id);
    const originalName = (await readdir(srcDir)).find((f) => f.startsWith('original.'));
    if (!originalName) throw new ApiError('CANDIDATE_UNAVAILABLE', 'the file is gone', { reason: 'DOWNLOAD_FAILED' });
    const ext = extname(originalName).slice(1).toLowerCase();
    const format: Subtitle['format'] = ext === 'ssa' || ext === 'ass' ? 'ass' : ext === 'vtt' ? 'vtt' : 'srt';
    const alignDone = c.align_state === 'done' ? (c.align_result as AlignResult | null) : null;
    const doc: SyncDoc = {
      ...SyncCore.identityDoc(),
      segments: alignDone?.segments?.length ? alignDone.segments : SyncCore.identityDoc().segments,
      checkpoints: SyncCore.pickCheckpoints(cues, CHECKPOINT_COUNT),
    };
    const speech = await speechFor(pool, config.dataDir, c.torrent_id);
    const score = speech ? scoreOf(speech.speech, cues, doc) : (c.align_score ?? null);

    const newId = randomUUID();
    const work = join(config.dataDir, 'tmp', 'work', `add-${newId}`);
    let placed = false;
    try {
      await mkdir(work, { recursive: true });
      await copyFile(join(srcDir, originalName), join(work, `original.${ext}`));
      await writeFile(join(work, 'cues.json'), cuesJson);
      if (convert) await writeFile(join(work, 'cues.original.json'), JSON.stringify(original));
      let bytes = 0;
      for (const f of await readdir(work)) bytes += (await stat(join(work, f))).size;
      if (!(await one(pool, `select 1 from torrents where id = $1 and want <> 'remove'`, [c.torrent_id])))
        throw new ApiError('NOT_FOUND', 'the film is being removed');
      await mkdir(join(config.dataDir, 'subtitles'), { recursive: true });
      await rename(work, subtitleDir(config.dataDir, newId));
      placed = true;
      const ins = await pool.query(
        `insert into subtitles (id, torrent_id, provider, provider_ref, release_name, language, format, original_encoding, converted_s2t,
                                cue_count, rel_dir, bytes, sha256, score, doc, added_by, updated_by)
         select $1, t.id, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $16
           from torrents t where t.id = $2 and t.want <> 'remove'`,
        [
          newId,
          c.torrent_id,
          c.provider,
          c.provider_ref,
          c.release_name,
          convert ? 'zh-Hant' : c.language,
          format,
          c.detected_encoding,
          convert,
          cues.length,
          subtitleRel(newId),
          bytes,
          sha,
          score,
          doc,
          user.id,
        ],
      );
      if (!ins.rowCount) throw new ApiError('NOT_FOUND', 'the film is being removed');
    } catch (err) {
      // Our own folder, written for a row that could not be added (docs/07, "加入" step 6).
      if (placed) await removeOwnSubtitleOutput(config.dataDir, 'subtitle', newId);
      if (pgCode(err) === UNIQUE_VIOLATION) throw new ApiError('SUBTITLE_DUPLICATE', 'this subtitle is already added');
      throw err;
    } finally {
      await removeWorkDir(config.dataDir, work);
    }
    await audit(
      pool,
      user,
      'subtitle.add',
      { movieTitle: t.title, language: convert ? 'zh-Hant' : c.language },
      req.ip,
    );
    const s = await subtitleRow(pool, newId);
    if (!s) throw new ApiError('NOT_FOUND', 'the film is being removed');
    await publishSubtitle(pool, events, {
      torrentId: s.torrent_id,
      subtitleId: s.id,
      rev: s.doc_rev,
      removed: false,
      by: { id: user.id, displayName: user.displayName },
    });
    await publishCandidates(pool, events, s.torrent_id);
    await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
    return toSubtitle(s);
  });

  app.delete('/api/candidates/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { c, t } = await holderCandidate(user, id);
    const r = await pool.query('delete from subtitle_candidates where id = $1', [id]);
    if (r.rowCount) {
      await removeCandidateFiles(config.dataDir, id, deps.log);
      await audit(
        pool,
        user,
        'subtitle.candidate.remove',
        { movieTitle: t.title, releaseName: c.release_name },
        req.ip,
      );
      await changedCandidates(c.torrent_id);
      await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
    }
    return reply.status(204).send();
  });

  /* -------------------------------------------------------------- added subtitles */

  app.get('/api/torrents/:id/subtitles', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    await holderTorrent(deps, user, id);
    return (await subtitleRows(pool, id)).map(toSubtitle);
  });

  app.get('/api/subtitles/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { s } = await holderSubtitle(user, id);
    return { subtitle: toSubtitle(s), cues: await readCues(config.dataDir, s.rel_dir), doc: s.doc };
  });

  app.put('/api/subtitles/:id/doc', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(
      z.object({ rev: z.number().int().min(0), doc: z.unknown(), reason: z.enum(['auto-align', 'reset']).optional() }),
      req.body,
    );
    const { s } = await holderSubtitle(user, id);
    const doc = cleanDoc(body.doc, s.cue_count);
    const cues = await readCues(config.dataDir, s.rel_dir);
    const speech = await speechFor(pool, config.dataDir, s.torrent_id);
    const out = await tx(pool, async (c) => {
      const cur = await one<{
        doc: SyncDoc;
        doc_rev: number;
        status: Subtitle['status'];
        updated_by: string | null;
        name: string | null;
      }>(
        c,
        `select s.doc, s.doc_rev, s.status, s.updated_by, u.display_name as name
           from subtitles s join torrents t on t.id = s.torrent_id and t.want <> 'remove' left join users u on u.id = s.updated_by
          where s.id = $1 for update of s`,
        [id],
      );
      if (!cur) throw new ApiError('NOT_FOUND', 'no such subtitle');
      if (cur.doc_rev !== body.rev)
        throw new ApiError('REVISION_CONFLICT', 'someone saved first', {
          rev: cur.doc_rev,
          doc: cur.doc,
          updatedBy: cur.updated_by ? { id: cur.updated_by, displayName: cur.name ?? '' } : null,
        });
      const status: Subtitle['status'] = changesTiming(cur.doc, doc) ? 'draft' : cur.status;
      const score = scoreOf(speech?.speech ?? null, cues, doc);
      const rev = cur.doc_rev + 1;
      await c.query(
        `update subtitles set doc = $2, doc_rev = $3, status = $4, score = $5, updated_by = $6, updated_at = now(),
                confirmed_by = case when $4 = 'draft' then null else confirmed_by end,
                confirmed_at = case when $4 = 'draft' then null else confirmed_at end
          where id = $1`,
        [id, doc, rev, status, score, user.id],
      );
      if (body.reason)
        await c.query(
          'insert into subtitle_revisions (subtitle_id, rev, doc, reason, author) values ($1, $2, $3, $4, $5)',
          [id, rev, doc, body.reason, user.id],
        );
      return { rev, status, score };
    });
    await publishSubtitle(pool, events, {
      torrentId: s.torrent_id,
      subtitleId: id,
      rev: out.rev,
      removed: false,
      by: { id: user.id, displayName: user.displayName },
    });
    return out;
  });

  /** Computed in the media service; the stored document is not touched (docs/09, "自動對齊"). */
  app.post('/api/subtitles/:id/auto-align', async (req) => {
    const user = requireUser(req);
    // Each press may ask a paid language model a dozen questions (docs/08, "語言模型").
    const wait = alignLimiter.retryAfter(user.id);
    if (wait > 0) throw new ApiError('RATE_LIMITED', 'too many alignments', { retryAfterSeconds: wait });
    alignLimiter.record(user.id);
    const { id } = parse(IdParams, req.params);
    const { allowSplit, referenceId } = parse(
      z.object({ allowSplit: z.boolean(), referenceId: z.uuid().optional() }),
      req.body,
    );
    const { s, t } = await holderSubtitle(user, id);
    let input: Record<string, unknown>;
    if (referenceId) {
      // Aligning to another subtitle of the same film: no sound and no language model needed.
      const ref = await one<{ id: string }>(pool, 'select id from subtitles where id = $1 and torrent_id = $2', [
        referenceId,
        s.torrent_id,
      ]);
      if (!ref || referenceId === id)
        throw new ApiError('VALIDATION', 'the reference must be another subtitle of the same film', {
          fields: { referenceId: 'NOT_SAME_FILM' },
        });
      input = { subtitleId: id, allowSplit, referenceId };
    } else {
      const sp = await speechFor(pool, config.dataDir, s.torrent_id);
      if (!sp) throw new ApiError('MEDIA_NOT_READY', 'no speech data for this film');
      // A subtitle in another language than the one spoken is paired by the language model here,
      // where the key is; the media service does the rest (docs/08, "語言模型").
      const heard = await llmHeard(deps, sp.mediaId, await readCues(config.dataDir, s.rel_dir), s.language);
      input = { subtitleId: id, allowSplit, heard };
    }
    const task = await one<{ id: string }>(
      pool,
      `insert into tasks (kind, torrent_id, subject, input, created_by) values ('align', $1, $2, $3, $4) returning id`,
      [s.torrent_id, { movieTitle: t.title, language: s.language }, input, user.id],
    );
    const taskId = task?.id as string;
    await pool.query(`select pg_notify('paiban_media', '{}')`);
    await pool.query(`select pg_notify('paiban_events', $1)`, [JSON.stringify({ type: 'task', id: taskId })]);
    const finished = await waitForTask(deps, taskId, ALIGN_WAIT_MS);
    if (finished?.state === 'done' && finished.result) return finished.result as AlignResult;
    if (!finished)
      await pool.query(
        `update tasks set state = 'failed', error_code = 'TIMEOUT', finished_at = now() where id = $1 and state in ('queued', 'running')`,
        [taskId],
      );
    throw new ApiError(
      'ALIGN_FAILED',
      finished ? `alignment failed: ${finished.error_code ?? 'unknown'}` : 'alignment timed out',
    );
  });

  app.post('/api/subtitles/:id/confirm', async (req) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const body = parse(z.object({ rev: z.number().int().min(0), force: z.boolean().optional() }), req.body);
    const { t } = await holderSubtitle(user, id);
    const done = await tx(pool, async (c) => {
      const cur = await one<{
        doc: SyncDoc;
        doc_rev: number;
        language: string;
        updated_by: string | null;
        name: string | null;
      }>(
        c,
        `select s.doc, s.doc_rev, s.language, s.updated_by, u.display_name as name
           from subtitles s join torrents t on t.id = s.torrent_id and t.want <> 'remove' left join users u on u.id = s.updated_by
          where s.id = $1 for update of s`,
        [id],
      );
      if (!cur) throw new ApiError('NOT_FOUND', 'no such subtitle');
      if (cur.doc_rev !== body.rev)
        throw new ApiError('REVISION_CONFLICT', 'someone saved first', {
          rev: cur.doc_rev,
          doc: cur.doc,
          updatedBy: cur.updated_by ? { id: cur.updated_by, displayName: cur.name ?? '' } : null,
        });
      if (!body.force && cur.doc.checkpoints.some((k) => k.status !== 'ok'))
        throw new ApiError('VALIDATION', 'checkpoints not all confirmed', { fields: { force: 'CHECKPOINTS_PENDING' } });
      await c.query(
        `update subtitles set status = 'confirmed', confirmed_by = $2, confirmed_at = now(), updated_at = now() where id = $1`,
        [id, user.id],
      );
      await c.query(
        `insert into subtitle_revisions (subtitle_id, rev, doc, reason, author) values ($1, $2, $3, 'confirm', $4)`,
        [id, cur.doc_rev, cur.doc, user.id],
      );
      await audit(c, user, 'subtitle.confirm', { movieTitle: t.title, language: cur.language }, req.ip);
      // The film's other holders hear about it (docs/09, "確認" step 4).
      const notes = await c.query<{ id: number; user_id: string }>(
        `insert into notifications (user_id, kind, data, link)
         select h.user_id, 'subtitle.confirmed', jsonb_build_object('actor', $3::text, 'movieTitle', $4::text, 'language', $5::text),
                jsonb_build_object('page', 'workspace', 'torrentId', $6::text, 'tab', 'sync')
           from torrent_holders h where h.torrent_id = $1 and h.user_id <> $2 returning id, user_id`,
        [t.id, user.id, user.displayName, t.title, cur.language, t.id],
      );
      return { rev: cur.doc_rev, notes: notes.rows };
    });
    for (const n of done.notes) {
      const r = await one<{ n: import('@paiban/shared').Notification }>(
        pool,
        `select ${NOTIFICATION_JSON} as n from notifications where id = $1`,
        [n.id],
      );
      if (r) events.toUser(n.user_id, { type: 'notification', notification: r.n });
    }
    await publishSubtitle(pool, events, {
      torrentId: t.id,
      subtitleId: id,
      rev: done.rev,
      removed: false,
      by: { id: user.id, displayName: user.displayName },
    });
    const s = await subtitleRow(pool, id);
    if (!s) throw new ApiError('NOT_FOUND', 'no such subtitle');
    return toSubtitle(s);
  });

  app.get('/api/subtitles/:id/file', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { synced } = parse(z.object({ synced: z.enum(['true', 'false', '1', '0']).optional() }), req.query);
    const { s, t } = await holderSubtitle(user, id);
    const cues = await readCues(config.dataDir, s.rel_dir);
    const useDoc = synced === 'true' || synced === '1';
    const srt = SyncCore.toSrt(SyncCore.applyDoc(cues, useDoc ? s.doc : SyncCore.identityDoc()));
    const name = `${t.title} (${t.year}).${langTag(s.language)}.srt`;
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return reply
      .header('Content-Type', 'application/x-subrip; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`)
      .header('Cache-Control', 'private, no-store')
      .send(srt);
  });

  app.delete('/api/subtitles/:id', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const { s, t } = await holderSubtitle(user, id);
    const r = await pool.query(
      `delete from subtitles s using torrents t where s.id = $1 and t.id = s.torrent_id and t.want <> 'remove'`,
      [id],
    );
    if (r.rowCount) {
      await removeSubtitleFiles(config.dataDir, id, deps.log);
      await audit(pool, user, 'subtitle.remove', { movieTitle: t.title, language: s.language }, req.ip);
      await publishSubtitle(pool, events, {
        torrentId: s.torrent_id,
        subtitleId: id,
        rev: s.doc_rev,
        removed: true,
        by: { id: user.id, displayName: user.displayName },
      });
      await publishCandidates(pool, events, s.torrent_id);
      await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
    }
    return reply.status(204).send();
  });
}

/**
 * Waits for a task another service works on: woken by NOTIFY {type: 'task', id} through the event
 * listener, and checking the row twice a second as well, so a missed notification costs at most
 * half a second. Null when it did not finish in time.
 */
export async function waitForTask(
  deps: Deps,
  taskId: string,
  timeoutMs: number,
): Promise<{ state: string; result: unknown; error_code: string | null } | null> {
  const read = () =>
    one<{ state: string; result: unknown; error_code: string | null }>(
      deps.pool,
      `select state, result, error_code from tasks where id = $1 and state in ('done', 'failed', 'cancelled')`,
      [taskId],
    );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await read();
    if (r) return r;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    await new Promise<void>((resolve) => {
      const off = deps.events.onTask(taskId, () => {
        clearTimeout(timer);
        off();
        resolve();
      });
      const timer = setTimeout(
        () => {
          off();
          resolve();
        },
        Math.min(500, left),
      );
    });
  }
}

export type { ProviderId };
