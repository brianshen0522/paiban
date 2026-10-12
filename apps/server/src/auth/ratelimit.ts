/**
 * Attempt counters kept in memory: the api runs as a single instance (docs/12-auth.md, "Attempt limits").
 * A key is blocked once `limit` attempts fall inside the window; it reports how long until the
 * oldest of them leaves the window.
 */
export class AttemptLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Seconds to wait when blocked, otherwise 0. */
  retryAfter(key: string): number {
    const list = this.prune(key);
    if (list.length < this.limit) return 0;
    const oldest = list[0] ?? this.now();
    return Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000));
  }

  record(key: string): void {
    const list = this.prune(key);
    list.push(this.now());
    this.hits.set(key, list);
  }

  clear(key: string): void {
    this.hits.delete(key);
  }

  private prune(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }
}
