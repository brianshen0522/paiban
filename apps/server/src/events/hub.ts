import type { ServerEvent } from '@paiban/shared';

/**
 * The open Server-Sent Events connections (docs/04-api.md, "即時更新"). Callers decide who may see
 * an event; the hub only delivers. Events are reminders: a page that reconnects refetches.
 */
type Client = { userId: string; admin: boolean; write: (chunk: string) => void };

export class EventHub {
  private readonly clients = new Set<Client>();
  private readonly taskWaiters = new Map<string, Set<() => void>>();

  /** Calls `fn` when another service announces that task `id` changed (NOTIFY {type: 'task', id}). */
  onTask(id: string, fn: () => void): () => void {
    let set = this.taskWaiters.get(id);
    if (!set) {
      set = new Set();
      this.taskWaiters.set(id, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
      if (set.size === 0) this.taskWaiters.delete(id);
    };
  }

  taskChanged(id: string): void {
    for (const fn of [...(this.taskWaiters.get(id) ?? [])]) fn();
  }

  add(client: Client): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  /** Users with at least one open connection, so per-viewer events are built only for them. */
  connectedUsers(): Set<string> {
    return new Set([...this.clients].map((c) => c.userId));
  }

  toUser(userId: string, event: ServerEvent): void {
    for (const c of this.clients) if (c.userId === userId) c.write(frame(event));
  }

  toAll(event: ServerEvent): void {
    const f = frame(event);
    for (const c of this.clients) c.write(f);
  }

  toAdmins(event: ServerEvent): void {
    const f = frame(event);
    for (const c of this.clients) if (c.admin) c.write(f);
  }

  get size(): number {
    return this.clients.size;
  }
}

const frame = (event: ServerEvent) => `data: ${JSON.stringify(event)}\n\n`;
