import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MediaStatus } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, tx } from '../db/pool.js';
import { publishTorrent, publishUsage } from '../events/publish.js';
import type { AuthedUser, Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireUser } from '../http/guards.js';
import { sendFile } from '../http/send-file.js';
import { readSettings } from '../settings/settings.js';
import { admit } from '../storage/usage.js';
import { mediaStatus, selectTorrents, type TorrentRow, versionLabel } from '../torrents/view.js';
import { assetReserve, mimeOf } from './probe.js';

const Params = z.object({ id: z.uuid() });

/** The film behind a media id, if the caller holds it (administrators included: docs/12-auth.md). */
async function holderMedia(deps: Deps, user: AuthedUser, id: string): Promise<TorrentRow> {
  const [row] = await selectTorrents(deps.pool, 'mf.id = $1', [id]);
  if (!row) throw new ApiError('NOT_FOUND', 'no such media');
  if (!row.holders.some((h) => h.id === user.id)) throw new ApiError('NOT_HOLDER', 'not a holder of this film');
  return row;
}

export function mediaRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, config } = deps;
  const status = async (id: string, row?: TorrentRow): Promise<MediaStatus> => {
    const r = row ?? (await selectTorrents(pool, 'mf.id = $1', [id]))[0];
    const s = r ? mediaStatus(r, (await readSettings(pool)).media.proxyResolution) : null;
    if (!s) throw new ApiError('NOT_FOUND', 'no such media');
    return s;
  };

  app.get('/api/media/:id', async (req) => {
    const { id } = parse(Params, req.params);
    const row = await holderMedia(deps, requireUser(req), id);
    return status(id, row);
  });

  app.get('/api/media/:id/original', async (req, reply) => {
    const { id } = parse(Params, req.params);
    const row = await holderMedia(deps, requireUser(req), id);
    if (row.state !== 'completed' || !row.rel_path) throw new ApiError('MEDIA_NOT_READY', 'download not finished');
    return sendFile(
      req,
      reply,
      join(config.dataDir, 'torrents', row.info_hash, row.rel_path),
      mimeOf(row.container, row.rel_path),
    );
  });

  for (const [asset, file, mime] of [
    ['proxy', 'proxy.mp4', 'video/mp4'],
    ['audio', 'audio.m4a', 'audio/mp4'],
  ] as const) {
    app.get(`/api/media/:id/${asset}`, async (req, reply) => {
      const { id } = parse(Params, req.params);
      const row = await holderMedia(deps, requireUser(req), id);
      if ((asset === 'proxy' ? row.proxy_state : row.audio_state) !== 'ready')
        throw new ApiError('NOT_FOUND', `no ${asset}`);
      return sendFile(req, reply, join(config.dataDir, 'media', id, file), mime);
    });
  }

  /** Waveform and speech: MEDIA_NOT_READY while the analysis waits or runs, 404 once it ended without the file. */
  for (const [what, file, mime] of [
    ['peaks', 'peaks.bin', 'application/octet-stream'],
    ['speech', 'speech.json', 'application/json'],
  ] as const) {
    app.get(`/api/media/:id/${what}`, async (req, reply) => {
      const { id } = parse(Params, req.params);
      const row = await holderMedia(deps, requireUser(req), id);
      if (row.analysis_state === 'pending' || row.analysis_state === 'running')
        throw new ApiError('MEDIA_NOT_READY', 'analysis not finished');
      const path = join(config.dataDir, 'media', id, file);
      const s = await stat(path).catch(() => null);
      if (!s) throw new ApiError('NOT_FOUND', `no ${what}`);
      reply.header('Cache-Control', 'private, max-age=3600').type(mime);
      return reply.send(createReadStream(path));
    });
  }

  /**
   * Asks for the analysis (docs/04-api.md): `none` or `failed` becomes `pending`; a failed probe is
   * redone too, and so is missing speech recognition once the analysis is there.
   */
  app.post('/api/media/:id/analyze', async (req) => {
    const { id } = parse(Params, req.params);
    const row = await holderMedia(deps, requireUser(req), id);
    if (row.state !== 'completed') throw new ApiError('MEDIA_NOT_READY', 'download not finished');
    const changed = await pool.query(
      `update media_files set analysis_state = 'pending', error = error - 'analysis',
              probe_state = case when probe_state = 'failed' then 'pending' else probe_state end, updated_at = now()
        where id = $1 and analysis_state in ('none', 'failed')`,
      [id],
    );
    // A film analysed already may still lack recognition: failed, or switched off back then.
    const asr = (await readSettings(pool)).align.asr
      ? await pool.query(
          `update media_files set asr_state = 'pending', error = error - 'asr', updated_at = now()
            where id = $1 and analysis_state = 'ready' and asr_state in ('none', 'failed') and audio_codec is not null`,
          [id],
        )
      : { rowCount: 0 };
    if (changed.rowCount || asr.rowCount) {
      await pool.query(`select pg_notify('paiban_media', '{}')`);
      await publishTorrent(pool, deps.events, row.id);
    }
    return status(id);
  });

  /**
   * Preview assets on request (docs/08, "Requesting later"): the missing ones become pending with the
   * current resolution, after admission of what they reserve together.
   */
  app.post('/api/media/:id/proxy', async (req) => {
    const user = requireUser(req);
    const { id } = parse(Params, req.params);
    const row = await holderMedia(deps, user, id);
    if (row.state !== 'completed') throw new ApiError('MEDIA_NOT_READY', 'download not finished');
    if (row.direct_play) return status(id, row);
    const { media } = await readSettings(pool);
    const requested = await tx(pool, async (c) => {
      const m = await one<{
        audio_state: string;
        proxy_state: string;
        duration_s: number | null;
        has_audio: boolean;
        probe_state: string;
        runtime_min: number;
      }>(
        c,
        `select mf.audio_state, mf.proxy_state, mf.duration_s, (mf.probe_state <> 'ready' or mf.audio_codec is not null) as has_audio, mf.probe_state, mv.runtime_min
           from media_files mf join torrents t on t.id = mf.torrent_id join movies mv on mv.id = t.movie_id where mf.id = $1 for update of mf`,
        [id],
      );
      if (!m) throw new ApiError('NOT_FOUND', 'no such media');
      const audio = m.has_audio && (m.audio_state === 'none' || m.audio_state === 'failed');
      const proxy = m.proxy_state === 'none' || m.proxy_state === 'failed';
      if (!audio && !proxy) return false;
      const bytes =
        (audio ? assetReserve(m.duration_s, m.runtime_min, 'audio') : 0) +
        (proxy ? assetReserve(m.duration_s, m.runtime_min, media.proxyResolution) : 0);
      await admit(c, deps.disk, config.storageReserveBytes, { bytes, previewBytes: bytes });
      await c.query(
        `update media_files set audio_state = case when $2 then 'pending' else audio_state end,
                proxy_state = case when $3 then 'pending' else proxy_state end,
                proxy_res = case when $3 then $4 else proxy_res end, proxy_progress = case when $3 then 0 else proxy_progress end,
                reserve_bytes = reserve_bytes + $5, error = error - 'audio' - 'proxy',
                probe_state = case when probe_state = 'failed' then 'pending' else probe_state end, updated_at = now()
          where id = $1`,
        [id, audio, proxy, media.proxyResolution, bytes],
      );
      await audit(c, user, 'media.preview.request', { movieTitle: row.title, version: versionLabel(row) }, req.ip);
      return true;
    });
    if (requested) {
      await pool.query(`select pg_notify('paiban_media', '{}')`);
      await publishTorrent(pool, deps.events, row.id);
      await publishUsage(pool, deps.events);
    }
    return status(id);
  });
}
