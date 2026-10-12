import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lang, SourceCheckCode } from '@paiban/shared';
import { many, one } from '../db/pool.js';
import { publishCandidates } from '../events/publish.js';
import type { Deps } from '../http/context.js';
import { recordSourceHealth } from '../settings/health.js';
import { readSecret } from '../settings/secrets.js';
import { readSettings } from '../settings/settings.js';
import { removeStaging } from '../storage/remove.js';
import {
  DownloadFailure,
  FILE_MAX,
  type FoundSubtitle,
  healthSource,
  PROVIDER_ORDER,
  type ProviderEnv,
  ProviderFailure,
  type ProviderKey,
  providerFor,
  request,
} from './providers/index.js';
import { coveredLanguages, filmContext, type StagedFile, stagingDir } from './store.js';

/**
 * The api's share of subtitle work (docs/07-subtitle-providers.md, "Who does which step"): searching the
 * sources, and asking them for download addresses and downloading. Both need keys only the api
 * can open. There is no queue: the rows are the work. A search is a `subtitle_searches` row in
 * 'running'; a download is a candidate in 'fetching' with nothing staged yet. Each source has its
 * own lane, so a slow one never holds up the others; a restart picks the rows up again.
 *
 * The download lands in /data/tmp/uploads/<candidate id>/ (files plus manifest.json), the same
 * place an upload waits; the media service turns either into cues. Addresses, temporary or not,
 * are never written to a table or a log.
 */
type Lane = `search:${ProviderKey}` | `fetch:${ProviderKey}`;

export class SubtitleWorker {
  private readonly deps: Deps;
  private readonly busy = new Set<Lane>();
  private readonly again = new Set<Lane>();
  private readonly refresh = new Set<string>();
  private readonly autoRetried = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private stopping = false;
  private running = 0;
  private idleWaiters: (() => void)[] = [];

  constructor(deps: Deps) {
    this.deps = deps;
  }

  env(): ProviderEnv {
    return {
      pool: this.deps.pool,
      outbound: this.deps.outbound,
      log: this.deps.log,
      secret: (name) => readSecret(this.deps, name),
    };
  }

  /** At start-up: searches left running and downloads left half-done by a previous run, and pending automatic retries. */
  async start(): Promise<void> {
    const waiting = await many<{ torrent_id: string; provider: ProviderKey; retry_at: Date }>(
      this.deps.pool,
      `select torrent_id, provider, retry_at from subtitle_searches where state = 'error' and error_code = 'RATE_LIMITED' and retry_at is not null`,
    );
    for (const w of waiting) this.scheduleRetry(w.torrent_id, w.provider, w.retry_at);
    for (const p of PROVIDER_ORDER) {
      this.kick(`search:${p}`);
      this.kick(`fetch:${p}`);
    }
  }

  stop(): void {
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  /** Resolves when no lane has work in hand (tests). */
  idle(): Promise<void> {
    if (this.running === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  search(torrentId: string, provider: ProviderKey, refresh: boolean): void {
    const key = `${torrentId}:${provider}`;
    if (refresh) this.refresh.add(key);
    else this.refresh.delete(key);
    this.autoRetried.delete(key);
    this.kick(`search:${provider}`);
  }

  fetch(provider: ProviderKey): void {
    this.kick(`fetch:${provider}`);
  }

  private kick(lane: Lane): void {
    if (this.stopping) return;
    if (this.busy.has(lane)) {
      this.again.add(lane);
      return;
    }
    this.busy.add(lane);
    this.running++;
    void this.drain(lane)
      .catch((err) => this.deps.log.error({ err, lane }, 'subtitle lane failed'))
      .finally(() => {
        this.busy.delete(lane);
        this.running--;
        if (this.again.delete(lane)) this.kick(lane);
        else if (this.running === 0) for (const r of this.idleWaiters.splice(0)) r();
      });
  }

  private async drain(lane: Lane): Promise<void> {
    const [kind, provider] = lane.split(':') as ['search' | 'fetch', ProviderKey];
    const tried = new Set<string>();
    for (;;) {
      if (this.stopping) return;
      if (kind === 'search') {
        const next = await one<{ torrent_id: string }>(
          this.deps.pool,
          `select torrent_id from subtitle_searches where provider = $1 and state = 'running' and not (torrent_id = any($2::uuid[]))
            order by started_at limit 1`,
          [provider, [...tried]],
        );
        if (!next) return;
        tried.add(next.torrent_id);
        await this.runSearch(next.torrent_id, provider);
      } else {
        const rows = await many<{ id: string }>(
          this.deps.pool,
          `select c.id from subtitle_candidates c join torrents t on t.id = c.torrent_id
            where c.provider = $1 and c.fetch_state = 'fetching' and t.want <> 'remove' and not (c.id = any($2::uuid[]))
            order by c.fetch_started_at`,
          [provider, [...tried]],
        );
        let next: string | null = null;
        for (const r of rows) {
          tried.add(r.id);
          if (!(await exists(stagingDir(this.deps.config.dataDir, r.id)))) {
            next = r.id;
            break;
          }
        }
        if (!next) return;
        await this.runFetch(next, provider);
      }
    }
  }

  /* ---------------------------------------------------------------- search */

  private async runSearch(torrentId: string, provider: ProviderKey): Promise<void> {
    const { pool, log } = this.deps;
    // As text: a JavaScript Date would drop the microseconds and never match again.
    const row = await one<{ started_at: string; languages: Lang[] }>(
      pool,
      `select started_at::text, languages from subtitle_searches where torrent_id = $1 and provider = $2 and state = 'running'`,
      [torrentId, provider],
    );
    if (!row) return;
    const key = `${torrentId}:${provider}`;
    const settings = await readSettings(pool);
    const film = await filmContext(pool, torrentId);
    if (!film) return; // being removed; the row goes with the film
    const languages: Lang[] = row.languages.length ? row.languages : settings.subtitles.defaultLangs;
    const env = this.env();
    const source = healthSource(settings, provider);
    const cacheKey = [
      provider === 'justsubtitles' ? settings.providers.justsubtitles.mode : '',
      provider === 'yify' ? settings.providers.yify.baseUrl : '',
      film.imdbCode,
      [...languages].sort().join(','),
    ].join('|');
    const refresh = this.refresh.delete(key);
    try {
      let found: FoundSubtitle[] | null = null;
      if (!refresh) {
        const cached = await one<{ payload: FoundSubtitle[] }>(
          pool,
          'select payload from provider_cache where provider = $1 and cache_key = $2 and expires_at > now()',
          [provider, cacheKey],
        );
        found = cached?.payload ?? null;
      }
      if (!found) {
        found = await providerFor(env, settings, provider).search(film, languages);
        // Parsed results only: a raw answer may carry somebody else's key (docs/07, "Caching").
        await pool.query(
          `insert into provider_cache (provider, cache_key, payload, expires_at) values ($1, $2, $3, now() + make_interval(hours => $4))
           on conflict (provider, cache_key) do update set payload = excluded.payload, fetched_at = now(), expires_at = excluded.expires_at`,
          [provider, cacheKey, JSON.stringify(found), settings.providers.cacheHours],
        );
      }
      const list = found;
      const written = await this.deps.pool.connect().then(async (c) => {
        try {
          await c.query('begin');
          const live = await one(c, `select 1 from torrents where id = $1 and want <> 'remove' for share`, [torrentId]);
          const fin = await c.query(
            `update subtitle_searches set state = 'ok', result_count = $3, error_code = null, retry_at = null, finished_at = now()
              where torrent_id = $1 and provider = $2 and state = 'running' and started_at = $4::timestamptz`,
            [torrentId, provider, list.length, row.started_at],
          );
          // Superseded by a newer search of the same source, or the film is going: drop these results.
          if (!live || !fin.rowCount) {
            await c.query('rollback');
            return false;
          }
          await writeCandidates(c, torrentId, provider, list, languages);
          await c.query('commit');
          return true;
        } catch (err) {
          await c.query('rollback').catch(() => undefined);
          throw err;
        } finally {
          c.release();
        }
      });
      if (written) await recordSourceHealth(pool, source, 'ok', 'OK', { count: list.length });
    } catch (err) {
      const f =
        err instanceof ProviderFailure
          ? err
          : new ProviderFailure('UNREACHABLE', err instanceof Error ? err.message : 'failed');
      if (!(err instanceof ProviderFailure)) log.warn({ err, provider }, 'subtitle search failed unexpectedly');
      // Assrt's limit: one automatic retry when the source is free again (docs/07, "Limits").
      const retryAt = f.code === 'RATE_LIMITED' && f.retryAt && !this.autoRetried.has(key) ? f.retryAt : null;
      const fin = await pool.query(
        `update subtitle_searches set state = 'error', error_code = $3, retry_at = $4, finished_at = now()
          where torrent_id = $1 and provider = $2 and state = 'running' and started_at = $5::timestamptz`,
        [torrentId, provider, f.code, retryAt, row.started_at],
      );
      if (fin.rowCount) {
        const [state, code]: ['warn' | 'down', SourceCheckCode] = f.invalidKey
          ? ['down', 'INVALID_KEY']
          : f.code === 'RATE_LIMITED' || f.code === 'NOT_CONFIGURED'
            ? ['warn', f.code]
            : ['down', f.code];
        await recordSourceHealth(
          pool,
          source,
          state,
          code,
          f.retryAt ? { retryAfterSeconds: Math.max(0, Math.round((f.retryAt.getTime() - Date.now()) / 1000)) } : {},
        );
        if (retryAt) this.scheduleRetry(torrentId, provider, retryAt);
      }
      log.info({ provider, code: f.code }, 'subtitle search ended with an error');
    }
    await publishCandidates(pool, this.deps.events, torrentId);
    await pool.query(`select pg_notify('paiban_media', '{}')`);
  }

  private scheduleRetry(torrentId: string, provider: ProviderKey, at: Date): void {
    if (this.stopping) return;
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        void this.deps.pool
          .query(
            `update subtitle_searches set state = 'running', started_at = now(), retry_at = null, error_code = null, finished_at = null
              where torrent_id = $1 and provider = $2 and state = 'error' and error_code = 'RATE_LIMITED' and retry_at = $3`,
            [torrentId, provider, at],
          )
          .then(async (r) => {
            if (!r.rowCount) return;
            this.autoRetried.add(`${torrentId}:${provider}`);
            this.refresh.add(`${torrentId}:${provider}`);
            await publishCandidates(this.deps.pool, this.deps.events, torrentId);
            this.kick(`search:${provider}`);
          })
          .catch((err) => this.deps.log.warn({ err }, 'automatic retry failed to start'));
      },
      Math.max(0, at.getTime() - Date.now()),
    );
    this.timers.add(timer);
  }

  /* ---------------------------------------------------------------- download */

  private async runFetch(candidateId: string, provider: ProviderKey): Promise<void> {
    const { pool, config, log } = this.deps;
    const c = await one<{ torrent_id: string; provider_ref: string; download_url: string | null }>(
      pool,
      `select torrent_id, provider_ref, download_url from subtitle_candidates where id = $1 and fetch_state = 'fetching'`,
      [candidateId],
    );
    if (!c) return;
    const settings = await readSettings(pool);
    const env = this.env();
    const source = providerFor(env, settings, provider);
    const partName = `${candidateId}.part`;
    const part = stagingDir(config.dataDir, partName);
    try {
      const downloads = await source.resolveDownload({ ref: c.provider_ref, downloadUrl: c.download_url });
      if (downloads.length === 0) throw new DownloadFailure('nothing to download');
      await removeStaging(config.dataDir, partName);
      await mkdir(part, { recursive: true });
      const manifest: StagedFile[] = [];
      for (const [i, d] of downloads.entries()) {
        const res = await request(env, d.url, {
          allow: (h) => source.allow(h),
          pace: provider,
          maxBytes: FILE_MAX,
          timeoutMs: 30_000,
        });
        if (res.status !== 200) throw new DownloadFailure(`download answered ${res.status}`);
        await writeFile(join(part, String(i)), res.body);
        manifest.push({ file: String(i), name: d.fileName });
      }
      await writeFile(join(part, 'manifest.json'), JSON.stringify(manifest));
      // Checked again right before it is handed over (docs/03, "What happens when a download is deleted").
      const still = await one(
        pool,
        `select 1 from subtitle_candidates c join torrents t on t.id = c.torrent_id
          where c.id = $1 and c.fetch_state = 'fetching' and t.want <> 'remove'`,
        [candidateId],
      );
      if (!still) {
        await removeStaging(config.dataDir, partName);
        return;
      }
      await rename(part, stagingDir(config.dataDir, candidateId));
      await pool.query(`select pg_notify('paiban_media', '{}')`);
    } catch (err) {
      await removeStaging(config.dataDir, partName);
      if (err instanceof DownloadFailure && err.layout)
        await recordSourceHealth(pool, healthSource(settings, provider), 'down', 'BAD_RESPONSE', {});
      log.info({ provider, err: err instanceof Error ? err.message : 'failed' }, 'subtitle download failed');
      await pool.query(
        `update subtitle_candidates set fetch_state = 'failed', fetch_error = 'DOWNLOAD_FAILED',
                align_state = case when align_state in ('queued', 'running') then 'failed' else align_state end
          where id = $1 and fetch_state = 'fetching'`,
        [candidateId],
      );
      await publishCandidates(pool, this.deps.events, c.torrent_id);
      await pool.query(`select pg_notify('paiban_media', '{}')`);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

const noQuery = (u: string | null) => {
  if (!u) return null;
  try {
    const x = new URL(u);
    x.search = '';
    x.hash = '';
    return x.toString();
  } catch {
    return null;
  }
};

/**
 * A source's new results (docs/03-data-model.md, "Candidates"): rows never fetched (`new`) or failed
 * are replaced; fetched ones stay. Only rows in the languages this search covered are replaced,
 * so a search for English does not wipe Chinese rows found earlier.
 */
async function writeCandidates(
  c: import('../db/pool.js').Client,
  torrentId: string,
  provider: ProviderKey,
  found: FoundSubtitle[],
  languages: Lang[],
): Promise<void> {
  for (const f of found)
    await c.query(
      `insert into subtitle_candidates (torrent_id, provider, provider_ref, language_label, language, release_name, uploader, page_url,
                                        download_url, flags)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       on conflict (torrent_id, provider, provider_ref) do update set
         language_label = excluded.language_label, language = excluded.language, release_name = excluded.release_name,
         uploader = excluded.uploader, page_url = excluded.page_url, download_url = excluded.download_url, flags = excluded.flags,
         fetch_state = 'new', fetch_error = null, fetch_started_at = null, align_state = 'none', align_score = null, align_result = null
       where subtitle_candidates.fetch_state in ('new', 'failed')`,
      [
        torrentId,
        provider,
        f.ref,
        f.languageLabel,
        f.language,
        f.releaseName,
        f.uploader,
        f.pageUrl,
        noQuery(f.downloadUrl),
        { hearingImpaired: f.hearingImpaired, ass: f.ass, rating: f.rating },
      ],
    );
  await c.query(
    `delete from subtitle_candidates where torrent_id = $1 and provider = $2 and fetch_state in ('new', 'failed')
       and language = any($3::text[]) and not (provider_ref = any($4::text[]))`,
    [torrentId, provider, coveredLanguages(languages), found.map((f) => f.ref)],
  );
}
