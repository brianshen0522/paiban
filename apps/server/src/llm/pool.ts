import type { LlmErrorCode, LlmParams, LlmProfile, LlmProvider, LlmPurpose } from '@paiban/shared';
import type { Logger } from 'pino';
import { many, type Pool } from '../db/pool.js';
import { openSecret, sealSecret } from '../settings/secrets.js';
import { askJson, type Connection, type JsonRequest, LlmError } from './providers.js';

/**
 * Which profile answers a request (docs/18-llm.md, "分配：負載平衡與備援"): the enabled profiles
 * in layers by priority; within the first layer that has one free, a weighted random pick among
 * those not cooling down and not at their concurrency limit. A failure cools the profile down
 * (60 s, or 10 min for a refused key) and the request moves to another one; at most four tries.
 * Cooling and in-flight counts live in memory: a restart forgets them, which only means one more
 * try against a service that may have recovered.
 */
export type ProfileRow = {
  id: string;
  name: string;
  provider: LlmProvider;
  base_url: string;
  api_version: string;
  model: string;
  priority: number;
  weight: number;
  enabled: boolean;
  params: LlmParams;
  key_nonce: Buffer | null;
  key_ciphertext: Buffer | null;
  updated_at: Date;
};

export const DEFAULT_PARAMS: LlmParams = {
  temperature: 0.2,
  maxTokens: 8000,
  // A translation chunk is 50 lines; a model that reasons first can take minutes (Brian's
  // gateway, 2026-10-07: 264 s with reasoning on, 24 s with it off).
  timeoutSeconds: 300,
  concurrency: 3,
  noReasoning: true,
  contextLength: 16_384,
};

const COOL_MS: Partial<Record<LlmErrorCode, number>> = {
  RATE_LIMITED: 60_000,
  UNREACHABLE: 60_000,
  TIMEOUT: 60_000,
  AUTH: 10 * 60_000,
  NOT_CONFIGURED: 10 * 60_000,
};
const MAX_TRIES = 4;
/** How long a request waits for a free slot before it gives up. */
const WAIT_MS = 10 * 60_000;

/** The associated data a profile's key is sealed with: it opens only for that row. */
export const keyName = (id: string) => `llm:${id}`;

export function sealKey(secretKey: string, id: string, value: string): { nonce: Buffer; ciphertext: Buffer } {
  return sealSecret(secretKey, keyName(id), value);
}

export type Caller = { purpose: LlmPurpose; userId: string | null; signal?: AbortSignal };

export class LlmPool {
  private readonly pool: Pool;
  private readonly secretKey: string;
  private readonly log: Logger;
  private readonly cooling = new Map<string, { until: number; code: LlmErrorCode }>();
  private readonly inFlight = new Map<string, number>();
  private readonly waiters = new Set<() => void>();
  private readonly random: () => number;

  constructor(d: { pool: Pool; secretKey: string; log: Logger; random?: () => number }) {
    this.pool = d.pool;
    this.secretKey = d.secretKey;
    this.log = d.log;
    this.random = d.random ?? Math.random;
  }

  async rows(): Promise<ProfileRow[]> {
    return many<ProfileRow>(this.pool, 'select * from llm_profiles order by priority, name, created_at');
  }

  /** The profile as the settings page shows it: no key, its cooling state from memory. */
  view(r: ProfileRow): LlmProfile {
    const cool = this.cooling.get(r.id);
    const cooling = cool && cool.until > Date.now() ? cool : null;
    return {
      id: r.id,
      name: r.name,
      provider: r.provider,
      baseUrl: r.base_url,
      apiVersion: r.api_version,
      model: r.model,
      priority: r.priority,
      weight: r.weight,
      enabled: r.enabled,
      params: { ...DEFAULT_PARAMS, ...r.params },
      keySet: !!r.key_ciphertext,
      coolingUntil: cooling ? new Date(cooling.until).toISOString() : null,
      lastError: cooling?.code ?? null,
      updatedAt: r.updated_at.toISOString(),
    };
  }

  /** A stored key, or null (none, or SECRET_KEY changed since; the administrator enters it again). */
  key(r: Pick<ProfileRow, 'id' | 'key_nonce' | 'key_ciphertext'>): string | null {
    if (!r.key_nonce || !r.key_ciphertext) return null;
    try {
      return openSecret(this.secretKey, keyName(r.id), r.key_nonce, r.key_ciphertext);
    } catch {
      this.log.warn(
        { profile: r.id },
        'a profile key cannot be decrypted with this SECRET_KEY; treating it as not set',
      );
      return null;
    }
  }

  connection(r: ProfileRow): Connection {
    return {
      provider: r.provider,
      baseUrl: r.base_url,
      apiVersion: r.api_version,
      model: r.model,
      key: this.key(r),
      params: { ...DEFAULT_PARAMS, ...r.params },
    };
  }

  /** Forget a profile's cooling (it was edited: the administrator fixed something). */
  reset(id: string): void {
    this.cooling.delete(id);
    this.wake();
  }

  /** Requests the first usable layer can take at once: how far a caller may fan out. */
  async capacity(): Promise<number> {
    const live = (await this.rows()).filter((r) => r.enabled);
    const first = live.filter((r) => r.priority === live[0]?.priority);
    return Math.max(
      1,
      Math.min(
        16,
        first.reduce((n, r) => n + { ...DEFAULT_PARAMS, ...r.params }.concurrency, 0),
      ),
    );
  }

  async hasProfiles(): Promise<boolean> {
    return (await this.rows()).some((r) => r.enabled);
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }

  private coolingNow(id: string): boolean {
    const c = this.cooling.get(id);
    if (!c) return false;
    if (c.until > Date.now()) return true;
    this.cooling.delete(id);
    return false;
  }

  /** A profile to try: first layer with a free one, weighted; null when all usable ones are busy; 'none' when none is usable at all. */
  private pick(live: ProfileRow[], tried: Set<string>): ProfileRow | null | 'none' {
    const usable = live.filter((r) => !tried.has(r.id) && !this.coolingNow(r.id));
    if (!usable.length) return 'none';
    const priorities = [...new Set(usable.map((r) => r.priority))].sort((a, b) => a - b);
    for (const p of priorities) {
      const free = usable.filter(
        (r) => r.priority === p && (this.inFlight.get(r.id) ?? 0) < { ...DEFAULT_PARAMS, ...r.params }.concurrency,
      );
      if (!free.length) continue;
      const total = free.reduce((n, r) => n + r.weight, 0);
      let x = this.random() * total;
      for (const r of free) {
        x -= r.weight;
        if (x < 0) return r;
      }
      return free[free.length - 1] ?? null;
    }
    return null;
  }

  private async waitForSlot(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', aborted);
        resolve();
      };
      const aborted = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        reject(signal?.reason ?? new Error('aborted'));
      };
      // Cooling ends without anyone waking us; look again every few seconds.
      const timer = setTimeout(done, 2_000);
      this.waiters.add(done);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }

  private async record(
    r: Pick<ProfileRow, 'id' | 'name'> | null,
    caller: Caller,
    ok: boolean,
    code: LlmErrorCode | null,
    ms: number,
  ): Promise<void> {
    await this.pool
      .query(
        `insert into llm_usage (profile_id, profile_name, purpose, user_id, ok, error_code, ms) values ($1, $2, $3, $4, $5, $6, $7)`,
        [r?.id || null, r?.name ?? '', caller.purpose, caller.userId, ok, code, Math.max(0, Math.round(ms))],
      )
      .catch((err) => this.log.warn({ err }, 'could not record a language-model call'));
  }

  /**
   * One question through the pool. Throws the last LlmError when every try failed, or
   * NOT_CONFIGURED when there is no enabled profile.
   */
  async ask<T>(req: JsonRequest<T>, caller: Caller): Promise<{ value: T; model: string; profile: string }> {
    const tried = new Set<string>();
    let last: LlmError | null = null;
    const deadline = Date.now() + WAIT_MS;
    while (tried.size < MAX_TRIES) {
      caller.signal?.throwIfAborted();
      const live = (await this.rows()).filter((r) => r.enabled);
      if (!live.length) throw new LlmError('NOT_CONFIGURED', 'no language model is set up');
      const r = this.pick(live, tried);
      if (r === 'none') break;
      if (r === null) {
        if (Date.now() > deadline) throw new LlmError('TIMEOUT', 'every profile stayed busy');
        await this.waitForSlot(caller.signal);
        continue;
      }
      tried.add(r.id);
      this.inFlight.set(r.id, (this.inFlight.get(r.id) ?? 0) + 1);
      const started = Date.now();
      try {
        const out = await askJson(this.connection(r), req, caller.signal);
        this.cooling.delete(r.id);
        await this.record(r, caller, true, null, Date.now() - started);
        return { ...out, profile: r.name };
      } catch (err) {
        if (caller.signal?.aborted) throw err;
        const e = err instanceof LlmError ? err : new LlmError('BAD_RESPONSE', String(err));
        last = e;
        const cool = COOL_MS[e.code];
        if (cool) this.cooling.set(r.id, { until: Date.now() + cool, code: e.code });
        await this.record(r, caller, false, e.code, Date.now() - started);
        this.log.warn({ profile: r.name, code: e.code }, 'language model call failed; trying another profile');
      } finally {
        this.inFlight.set(r.id, (this.inFlight.get(r.id) ?? 1) - 1);
        this.wake();
      }
    }
    throw last ?? new LlmError('UNREACHABLE', 'every profile is cooling down after a failure');
  }

  /** One question to a profile that may not be saved yet (the form's test button); recorded as a test. */
  async askOnce<T>(
    c: Connection,
    req: JsonRequest<T>,
    caller: Caller,
    who: Pick<ProfileRow, 'id' | 'name'> | null,
  ): Promise<{ value: T; model: string }> {
    const started = Date.now();
    try {
      const out = await askJson(c, req, caller.signal);
      await this.record(who, caller, true, null, Date.now() - started);
      return out;
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError('BAD_RESPONSE', String(err));
      await this.record(who, caller, false, e.code, Date.now() - started);
      throw e;
    }
  }
}
