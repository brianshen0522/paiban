import type { Logger } from 'pino';
import type { Config } from '../config.js';
import { many, type Pool } from '../db/pool.js';
import { decodeMetainfo } from '../torrents/metainfo.js';
import type { Engine } from './engine.js';

/** How long the swarm gets to hand over a magnet's metadata. */
export const METADATA_TIMEOUT_MS = 120_000;
/** At most this many metadata fetches at once. */
const PARALLEL = 3;

/**
 * Magnet links someone is adding by hand (docs/06-torrent-worker.md, "手動加入"): the api writes a
 * `torrent_inspections` row, this fetches the metadata into memory (nothing on disk) and writes it
 * back. The api's page polls the row. A fetch interrupted by a restart is failed, not resumed.
 */
export class Inspector {
  private readonly running = new Set<string>();
  private readonly pool: Pool;
  private readonly engine: Engine;
  private readonly config: Config;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  constructor(pool: Pool, engine: Engine, config: Config, log: Logger, timeoutMs = METADATA_TIMEOUT_MS) {
    this.pool = pool;
    this.engine = engine;
    this.config = config;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  /** Start-up: what was being fetched when the service stopped will not finish. */
  async recover(): Promise<void> {
    await this.pool.query(
      `update torrent_inspections set state = 'failed', error_code = 'NO_METADATA', finished_at = now() where state = 'pending' and source = 'magnet'`,
    );
  }

  async tick(): Promise<void> {
    const free = PARALLEL - this.running.size;
    if (free <= 0) return;
    const rows = await many<{ id: string; info_hash: string; trackers: string[] }>(
      this.pool,
      `select id, info_hash, trackers from torrent_inspections
        where state = 'pending' and source = 'magnet' and not (id = any($1::uuid[]))
        order by created_at limit $2`,
      [[...this.running], free],
    );
    for (const r of rows) {
      this.running.add(r.id);
      void this.fetch(r).finally(() => this.running.delete(r.id));
    }
  }

  private async fetch(r: { id: string; info_hash: string; trackers: string[] }): Promise<void> {
    const tr = this.config.torrentTestPeers.length ? [] : r.trackers;
    const magnet = `magnet:?xt=urn:btih:${r.info_hash}${tr.map((t) => `&tr=${encodeURIComponent(t)}`).join('')}`;
    try {
      const metainfo = await this.engine.fetchMetadata(magnet, this.timeoutMs, this.config.torrentTestPeers);
      const meta = await decodeMetainfo(metainfo);
      if (meta.infoHash !== r.info_hash) throw new Error('the swarm answered another torrent');
      await this.pool.query(
        `update torrent_inspections set state = 'ready', metainfo = $2, finished_at = now() where id = $1 and state = 'pending'`,
        [r.id, metainfo],
      );
    } catch (err) {
      this.log.info({ inspection: r.id, err: String(err).slice(0, 200) }, 'no metadata for a magnet link');
      await this.pool.query(
        `update torrent_inspections set state = 'failed', error_code = 'NO_METADATA', finished_at = now() where id = $1 and state = 'pending'`,
        [r.id],
      );
    }
  }
}
