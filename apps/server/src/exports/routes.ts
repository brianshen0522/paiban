import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Cue, type Export, exportNeedBytes, SyncCore, type SyncDoc } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { localeOf } from '../auth/users.js';
import { one, tx } from '../db/pool.js';
import { publishUsage } from '../events/publish.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { sendFile } from '../http/send-file.js';
import { removeExportFiles } from '../storage/remove.js';
import { admit } from '../storage/usage.js';
import { holderTorrent } from '../torrents/routes.js';
import { versionLabel } from '../torrents/view.js';
import { type ExportRow, publishExport, selectExports, type TrackRecord, toExport, trackTag } from './view.js';

const IdParams = z.object({ id: z.uuid() });
const CreateBody = z.object({
  fileName: z.string(),
  tracks: z.array(z.object({ subtitleId: z.uuid(), isDefault: z.boolean() })).max(32),
});
const ListQuery = z.object({ scope: z.enum(['mine', 'all']).default('mine') });

/**
 * The file name rules of db/schema.sql and docs/11-pages.md ("file name"), with a reason code the page
 * turns into one of its two sentences. Control characters are refused too: the name goes into a
 * header and onto someone's disk.
 */
export function fileNameProblem(name: string): 'EXTENSION' | 'CHARACTERS' | 'TOO_LONG' | null {
  if ([...name].length > 200) return 'TOO_LONG';
  if (!/\.mkv$/i.test(name) || name.trim().length <= 4) return 'EXTENSION';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(name)) return 'CHARACTERS';
  if (name !== name.trim() || name.startsWith('.')) return 'CHARACTERS';
  return null;
}

/** The sentence list stored with a subtitle: an array of cues (or {cues}, to be lenient). */
async function readCues(dataDir: string, subtitleId: string): Promise<Cue[]> {
  const raw: unknown = JSON.parse(await readFile(join(dataDir, 'subtitles', subtitleId, 'cues.json'), 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw as { cues?: unknown }).cues;
  if (!Array.isArray(list)) throw new Error(`cues.json of ${subtitleId} is not a list`);
  return list as Cue[];
}

/** The final SRT of a confirmed subtitle: applyDoc, then toSrt (docs/08-media-pipeline.md, "When an export is created (`api`)"). */
export function finalSrt(cues: Cue[], doc: SyncDoc): string {
  return SyncCore.toSrt(SyncCore.applyDoc(cues, doc));
}

async function visibleExport(deps: Deps, user: AuthedUser, id: string): Promise<ExportRow> {
  const [row] = await selectExports(deps.pool, 'e.id = $1', [id]);
  if (!row) throw new ApiError('NOT_FOUND', 'no such export');
  if (user.role === 'admin' || row.created_by === user.id) return row;
  if (row.torrent_id) {
    const held = await one(
      deps.pool,
      `select 1 from torrent_holders h join torrents t on t.id = h.torrent_id where h.torrent_id = $1 and h.user_id = $2 and t.want <> 'remove'`,
      [row.torrent_id, user.id],
    );
    if (held) return row;
  }
  throw new ApiError('NOT_FOUND', 'no such export');
}

export function exportRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;

  /** Start an export (docs/04-api.md, "Export"; docs/08-media-pipeline.md, "When an export is created (`api`)"). */
  app.post('/api/torrents/:id/exports', async (req, reply): Promise<Export> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const film = await holderTorrent(deps, user, id);
    const body = parse(CreateBody, req.body);
    if (body.tracks.length === 0) throw new ApiError('NO_CONFIRMED_SUBTITLE', 'no subtitle chosen');
    if (new Set(body.tracks.map((t) => t.subtitleId)).size !== body.tracks.length)
      throw new ApiError('VALIDATION', 'a subtitle is listed twice', { fields: { tracks: 'DUPLICATE' } });
    if (body.tracks.filter((t) => t.isDefault).length !== 1)
      throw new ApiError('VALIDATION', 'exactly one track must be the default', { fields: { tracks: 'ONE_DEFAULT' } });
    const problem = fileNameProblem(body.fileName);
    if (problem) throw new ApiError('INVALID_FILENAME', 'bad file name', { fields: { fileName: problem } });
    if (film.state !== 'completed' || !film.media_id) throw new ApiError('MEDIA_NOT_READY', 'download not finished');
    // The default track goes first: players show it (docs/08, the option table).
    const ordered = [...body.tracks.filter((t) => t.isDefault), ...body.tracks.filter((t) => !t.isDefault)];

    const exportId = randomUUID();
    const dir = join(config.dataDir, 'exports', exportId);
    let wrote = false;
    try {
      await tx(pool, async (c) => {
        const t = await one<{ want: string; size_bytes: number }>(
          c,
          `select t.want, mf.size_bytes from torrents t join media_files mf on mf.torrent_id = t.id where t.id = $1 for update of t`,
          [id],
        );
        if (!t || t.want === 'remove') throw new ApiError('NOT_FOUND', 'no such download');
        const subs = await c.query<{ id: string; language: string; status: string; doc: SyncDoc; doc_rev: number }>(
          `select id, language, status, doc, doc_rev from subtitles where torrent_id = $1 and id = any($2::uuid[]) for share`,
          [id, ordered.map((x) => x.subtitleId)],
        );
        const byId = new Map(subs.rows.map((s) => [s.id, s]));
        if (ordered.some((x) => byId.get(x.subtitleId)?.status !== 'confirmed'))
          throw new ApiError('NO_CONFIRMED_SUBTITLE', 'every track must be a confirmed subtitle of this film');
        const need = exportNeedBytes(t.size_bytes);
        await admit(c, deps.disk, config.storageReserveBytes, { bytes: need, previewBytes: 0 });

        const tracks: TrackRecord[] = [];
        const srts: string[] = [];
        for (const x of ordered) {
          const s = byId.get(x.subtitleId);
          if (!s) throw new Error('unreachable');
          srts.push(finalSrt(await readCues(config.dataDir, s.id), s.doc));
          tracks.push({
            subtitleId: s.id,
            rev: s.doc_rev,
            language: s.language as TrackRecord['language'],
            title: trackTag(s.language, localeOf(user.prefs)).title,
            isDefault: x.isDefault,
          });
        }
        await c.query(
          `insert into exports (id, torrent_id, movie_title, version_label, file_name, tracks, reserved_bytes, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [exportId, id, film.title, versionLabel(film), body.fileName, JSON.stringify(tracks), need, user.id],
        );
        await c.query(
          `insert into tasks (kind, torrent_id, subject, input, created_by) values ('export', $1, $2, $3, $4)`,
          [id, { movieTitle: film.title, fileName: body.fileName }, { exportId }, user.id],
        );
        // A record of use, written at most once an hour (docs/03-data-model.md, last_used_at).
        await c.query(
          `update torrents set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '1 hour')`,
          [id],
        );
        await audit(c, user, 'export.create', { movieTitle: film.title, fileName: body.fileName }, req.ip);
        // The final SRTs are written now, so later edits to the subtitles do not change this export.
        wrote = true;
        await mkdir(join(dir, 'tracks'), { recursive: true });
        for (const [n, srt] of srts.entries()) await writeFile(join(dir, 'tracks', `${n}.srt`), srt, 'utf8');
      });
    } catch (err) {
      // The transaction did not commit: the tracks just written belong to nothing.
      if (wrote) await removeExportFiles(config.dataDir, exportId, deps.log);
      throw err;
    }
    await pool.query(`select pg_notify('paiban_media', '{}')`);
    await publishExport(pool, deps.events, exportId);
    await publishUsage(pool, deps.events);
    deps.events.toAdmins({ type: 'admin', what: 'tasks' });
    const [row] = await selectExports(pool, 'e.id = $1', [exportId]);
    if (!row) throw new ApiError('NOT_FOUND', 'export vanished');
    return reply.status(201).send(toExport(row, user));
  });

  app.get('/api/exports', async (req): Promise<Export[]> => {
    const user = requireUser(req);
    const { scope } = parse(ListQuery, req.query);
    if (scope === 'all' && user.role !== 'admin') throw new ApiError('FORBIDDEN', 'administrators only');
    const rows =
      scope === 'all'
        ? await selectExports(pool, 'true', [])
        : await selectExports(pool, 'e.created_by = $1', [user.id]);
    return rows.map((r) => toExport(r, user));
  });

  /** The MKV, for the film's holders, its creator and administrators; Range lets downloads resume. */
  app.get('/api/exports/:id/file', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const row = await visibleExport(deps, user, id);
    if (row.state !== 'done' || !row.rel_path) throw new ApiError('NOT_FOUND', 'export not finished');
    return sendFile(req, reply, join(config.dataDir, 'exports', row.id, row.file_name), 'video/x-matroska', {
      downloadName: row.file_name,
    });
  });

  /**
   * Delete an export (docs/04-api.md): waiting, done or failed ones go now with their folder; a
   * running one is asked to stop and the media service removes it. Answers what is freed.
   */
  app.delete('/api/exports/:id', async (req): Promise<{ freedBytes: number }> => {
    const user = requireUser(req);
    const { id } = parse(IdParams, req.params);
    const row = await visibleExport(deps, user, id);
    if (user.role !== 'admin' && row.created_by !== user.id)
      throw new ApiError('FORBIDDEN', 'only its creator or an administrator');
    const out = await tx(pool, async (c) => {
      const e = await one<{ state: string; size_bytes: number; reserved_bytes: number; cancel_requested: boolean }>(
        c,
        'select state, size_bytes, reserved_bytes, cancel_requested from exports where id = $1 for update',
        [id],
      );
      if (!e || e.cancel_requested) throw new ApiError('NOT_FOUND', 'no such export');
      if (e.state === 'running') {
        await c.query('update exports set cancel_requested = true where id = $1', [id]);
      } else {
        await c.query('delete from exports where id = $1', [id]);
        await c.query(
          `update tasks set state = 'cancelled', finished_at = now() where kind = 'export' and input->>'exportId' = $1 and state in ('queued', 'running')`,
          [id],
        );
      }
      await audit(c, user, 'export.delete', { fileName: row.file_name }, req.ip);
      return { running: e.state === 'running', freed: e.state === 'done' ? e.size_bytes : e.reserved_bytes };
    });
    if (!out.running) await removeExportFiles(config.dataDir, id, deps.log);
    else await pool.query(`select pg_notify('paiban_media', '{}')`);
    deps.events.toAll({ type: 'export.removed', id });
    await publishUsage(pool, deps.events);
    deps.events.toAdmins({ type: 'admin', what: 'tasks' });
    return { freedBytes: out.freed };
  });
}
