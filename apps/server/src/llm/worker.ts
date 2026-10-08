import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Cue, SyncCore, type SyncDoc, type Translation } from '@paiban/shared';
import { audit } from '../audit.js';
import { localeOf } from '../auth/users.js';
import { many, one, type Queryable } from '../db/pool.js';
import { publishSubtitle } from '../events/publish.js';
import type { Deps } from '../http/context.js';
import { removeOwnSubtitleOutput, removeWorkDir } from '../storage/remove.js';
import { readCues, speechFor, subtitleDir, subtitleRel } from '../subtitles/store.js';
import { tmdbFilm } from '../tmdb/tmdb.js';
import { tmdbEnv } from '../yts/routes.js';
import type { LlmPool } from './pool.js';
import { LlmError } from './providers.js';
import { Answer, chunks, type Film, lineText, question, readAnswer } from './translate.js';

/**
 * Runs translations in the api, the only service with the keys (docs/18-llm.md, "進行中").
 * Chunks go one after another; each answered chunk is saved, so a failure or a restart carries on
 * from the next one. Nothing is written under /data until the last chunk is in; then the new
 * subtitle is written the way an added one is (a work folder renamed into place).
 */
export type TranslationRow = {
  id: string;
  torrent_id: string;
  source_id: string;
  target_language: string;
  mode: 'plain' | 'bilingual';
  state: Translation['state'];
  done_chunks: number;
  total_chunks: number;
  lines: (string | null)[];
  model: string;
  error_code: Translation['errorCode'];
  result_id: string | null;
  created_by: string | null;
  creator_name: string | null;
  created_at: Date;
  finished_at: Date | null;
};

export const TRANSLATION_SELECT = `select t.*, u.display_name as creator_name from translations t left join users u on u.id = t.created_by`;

export function toTranslation(r: TranslationRow): Translation {
  return {
    id: r.id,
    torrentId: r.torrent_id,
    sourceId: r.source_id,
    targetLanguage: r.target_language,
    mode: r.mode,
    state: r.state,
    doneChunks: r.done_chunks,
    totalChunks: r.total_chunks,
    errorCode: r.error_code,
    resultId: r.result_id,
    createdBy: r.created_by ? { id: r.created_by, displayName: r.creator_name ?? '' } : null,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
  };
}

export async function translationRow(q: Queryable, id: string): Promise<TranslationRow | null> {
  return one<TranslationRow>(q, `${TRANSLATION_SELECT} where t.id = $1`, [id]);
}

/** A chunk whose answer does not cover exactly its lines is asked again, this many times in all. */
const CHUNK_TRIES = 3;

export class TranslationWorker {
  private readonly deps: Deps;
  private readonly llm: LlmPool;
  private readonly running = new Map<string, AbortController>();
  private stopping = false;

  constructor(deps: Deps, llm: LlmPool) {
    this.deps = deps;
    this.llm = llm;
  }

  /** Translations a previous run left unfinished carry on. */
  async start(): Promise<void> {
    for (const r of await many<{ id: string }>(this.deps.pool, `select id from translations where state = 'running'`))
      this.kick(r.id);
  }

  stop(): void {
    this.stopping = true;
    for (const c of this.running.values()) c.abort();
  }

  /** Resolves once nothing is running (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await new Promise((r) => setTimeout(r, 20));
  }

  kick(id: string): void {
    if (this.stopping || this.running.has(id)) return;
    const ctl = new AbortController();
    this.running.set(id, ctl);
    void this.run(id, ctl.signal)
      .catch((err) => this.deps.log.error({ err, translation: id }, 'translation failed unexpectedly'))
      .finally(() => this.running.delete(id));
  }

  /** Stops a running translation's requests; the route has marked it cancelled already. */
  cancel(id: string): void {
    this.running.get(id)?.abort();
  }

  private async publish(id: string): Promise<void> {
    const r = await translationRow(this.deps.pool, id);
    if (!r) return;
    const holders = await many<{ user_id: string }>(
      this.deps.pool,
      'select user_id from torrent_holders where torrent_id = $1',
      [r.torrent_id],
    );
    for (const h of holders) this.deps.events.toUser(h.user_id, { type: 'translation', translation: toTranslation(r) });
  }

  private async fail(id: string, code: Translation['errorCode']): Promise<void> {
    await this.deps.pool.query(
      `update translations set state = 'failed', error_code = $2, finished_at = now() where id = $1 and state = 'running'`,
      [id, code],
    );
    await this.publish(id);
  }

  private async film(torrentId: string): Promise<Film | null> {
    const m = await one<{
      imdb_code: string;
      title: string;
      title_zh: string | null;
      year: number;
      genres: string[];
      summary: string;
    }>(
      this.deps.pool,
      `select m.imdb_code, m.title, m.title_zh, m.year, m.genres, m.summary
         from torrents t join movies m on m.id = t.movie_id where t.id = $1 and t.want <> 'remove'`,
      [torrentId],
    );
    if (!m) return null;
    // TMDB's Chinese overview when there is one (the cached answer; asked only once a week).
    const tmdb = await tmdbFilm(tmdbEnv(this.deps), m.imdb_code, m.title).catch(() => null);
    return {
      title: m.title,
      titleZh: tmdb?.titleZh ?? m.title_zh,
      year: m.year,
      genres: m.genres,
      overview: tmdb?.overview ?? m.summary,
    };
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const { pool, config } = this.deps;
    const t = await translationRow(pool, id);
    if (t?.state !== 'running') return;
    const src = await one<{ rel_dir: string; doc: SyncDoc; release_name: string }>(
      pool,
      'select rel_dir, doc, release_name from subtitles where id = $1',
      [t.source_id],
    );
    const film = await this.film(t.torrent_id);
    if (!src || !film) return this.fail(id, 'SOURCE_GONE');
    const cues = await readCues(config.dataDir, src.rel_dir);
    const texts = cues.map((c) => c.text);
    const done: (string | null)[] = Array.from({ length: cues.length }, (_, i) => t.lines[i] ?? null);
    const parts = chunks(cues.length);
    let model = t.model;
    for (let k = t.done_chunks; k < parts.length; k++) {
      const range = parts[k] as [number, number];
      const q = question(film, t.target_language, texts, done, range);
      let lines: string[] | null = null;
      let lastError: Translation['errorCode'] = 'BAD_RESPONSE';
      for (let tryNo = 0; tryNo < CHUNK_TRIES && !lines; tryNo++) {
        if (signal.aborted) return;
        try {
          const out = await this.llm.ask(
            { system: q.system, user: q.user, schema: Answer },
            { purpose: 'translate', userId: t.created_by, signal },
          );
          lines = readAnswer(out.value, q.ids);
          model = out.model;
          if (!lines) this.deps.log.warn({ translation: id, chunk: k }, 'a chunk came back incomplete; asking again');
        } catch (err) {
          if (signal.aborted) return;
          lastError = err instanceof LlmError ? err.code : 'BAD_RESPONSE';
          // Every profile already failed this request; another round would not help.
          if (err instanceof LlmError && err.code !== 'BAD_RESPONSE' && err.code !== 'REFUSED') break;
        }
      }
      if (!lines) return this.fail(id, lastError);
      lines.forEach((l, j) => {
        done[range[0] + j] = l;
      });
      const saved = await pool.query(
        `update translations set lines = $2, done_chunks = $3, model = $4 where id = $1 and state = 'running'`,
        [id, JSON.stringify(done), k + 1, model],
      );
      // Cancelled (or the film removed) while this chunk was out: stop here.
      if (!saved.rowCount) return;
      await this.publish(id);
    }
    await this.finish(t, cues, done, src, model);
  }

  /** The new subtitle: the original's lines with the translated text, and the original's sync result. */
  private async finish(
    t: TranslationRow,
    cues: Cue[],
    done: (string | null)[],
    src: { doc: SyncDoc; release_name: string },
    model: string,
  ): Promise<void> {
    const { pool, config, log } = this.deps;
    const out: Cue[] = cues.map((c, i) => ({ ...c, text: lineText(done[i] ?? c.text, c.text, t.mode) }));
    // Timing comes along (segments, line timing, deletions, checkpoints); the original's text edits do not.
    const edits: SyncDoc['edits'] = {};
    for (const [k, e] of Object.entries(src.doc.edits ?? {})) {
      const { text: _dropped, ...timing } = e;
      if (Object.keys(timing).length) edits[k] = timing;
    }
    const doc: SyncDoc = { ...src.doc, edits };
    const cuesJson = JSON.stringify(out);
    const sha = createHash('sha256').update(cuesJson).digest('hex');
    const same = await one<{ id: string }>(pool, 'select id from subtitles where torrent_id = $1 and sha256 = $2', [
      t.torrent_id,
      sha,
    ]);
    if (same) return this.done(t.id, same.id);
    const speech = await speechFor(pool, config.dataDir, t.torrent_id);
    const score = speech
      ? SyncCore.round3(SyncCore.totalScore(SyncCore.makeSpeech(speech.speech), SyncCore.applyDoc(out, doc)))
      : null;
    const newId = randomUUID();
    const work = join(config.dataDir, 'tmp', 'work', `translate-${newId}`);
    let placed = false;
    try {
      await mkdir(work, { recursive: true });
      await writeFile(join(work, 'original.srt'), SyncCore.toSrt(SyncCore.applyDoc(out, SyncCore.identityDoc())));
      await writeFile(join(work, 'cues.json'), cuesJson);
      let bytes = 0;
      for (const f of await readdir(work)) bytes += (await stat(join(work, f))).size;
      if (!(await one(pool, `select 1 from torrents where id = $1 and want <> 'remove'`, [t.torrent_id])))
        return this.fail(t.id, 'SOURCE_GONE');
      await mkdir(join(config.dataDir, 'subtitles'), { recursive: true });
      await rename(work, subtitleDir(config.dataDir, newId));
      placed = true;
      // Named in the language of the person who asked for it (Brian, 2026-10-08).
      const maker = t.created_by
        ? await one<{ prefs: Record<string, unknown> }>(pool, 'select prefs from users where id = $1', [t.created_by])
        : null;
      const name = (
        localeOf(maker?.prefs) === 'en'
          ? `AI translation (${model || 'language model'}) · ${src.release_name}`
          : `AI 翻譯（${model || '語言模型'}）· ${src.release_name}`
      ).slice(0, 300);
      const ins = await pool.query(
        `insert into subtitles (id, torrent_id, provider, provider_ref, release_name, language, format, cue_count, rel_dir,
                                bytes, sha256, score, doc, added_by, updated_by)
         select $1, t.id, 'translated', $3::text, $4, $5, 'srt', $6, $7, $8, $9, $10, $11, $12, $12
           from torrents t where t.id = $2 and t.want <> 'remove'
             and exists (select 1 from translations where id = $3::uuid and state = 'running')`,
        [
          newId,
          t.torrent_id,
          t.id,
          name,
          t.target_language,
          out.length,
          subtitleRel(newId),
          bytes,
          sha,
          score,
          doc,
          t.created_by,
        ],
      );
      if (!ins.rowCount) {
        // Cancelled at the last moment, or the film is going: our own folder goes with it.
        await removeOwnSubtitleOutput(config.dataDir, 'subtitle', newId);
        placed = false;
        return;
      }
    } catch (err) {
      if (placed) await removeOwnSubtitleOutput(config.dataDir, 'subtitle', newId);
      log.error({ err, translation: t.id }, 'could not write the translated subtitle');
      return this.fail(t.id, 'BAD_RESPONSE');
    } finally {
      await removeWorkDir(config.dataDir, work);
    }
    const title = await one<{ title: string }>(
      pool,
      'select m.title from torrents t join movies m on m.id = t.movie_id where t.id = $1',
      [t.torrent_id],
    );
    await audit(
      pool,
      t.created_by ? { id: t.created_by, displayName: t.creator_name ?? '' } : null,
      'subtitle.translate',
      {
        movieTitle: title?.title ?? '',
        language: t.target_language,
        mode: t.mode,
      },
    );
    await publishSubtitle(pool, this.deps.events, {
      torrentId: t.torrent_id,
      subtitleId: newId,
      rev: 0,
      removed: false,
      by: null,
    });
    await pool.query(`select pg_notify('paiban_events', '{"type":"usage"}')`);
    await this.done(t.id, newId);
  }

  private async done(id: string, resultId: string): Promise<void> {
    await this.deps.pool.query(
      `update translations set state = 'done', result_id = $2, finished_at = now() where id = $1 and state = 'running'`,
      [id, resultId],
    );
    await this.publish(id);
  }
}
