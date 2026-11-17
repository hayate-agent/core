import type { MemoryContext, MemoryProvider } from "./memory.js";

/** Stable provider identity for tools, orchestration and background capture.
 * Reconnect is exclusive: drain/close before opening the same backing store.
 * No datastore migration, forced termination or rollback of external effects.
 */
export class MemoryProviderLifecycle implements MemoryProvider {
  private current?: MemoryProvider;
  private users = 0;
  private drained?: () => void;
  private connecting?: Promise<void>;
  private stopping?: Promise<void>;
  private closed = false;
  private changing = false;
  private cleanupFailed = false;

  /** `scope` maps delegated worker keys to their owning conversation; unrelated sessions stay isolated.
   * Explicit lessons/decisions/notes are stored with the owner. Automatic turn records (`operation`)
   * keep their exact session key, so pending replay ids, handoff pointers and worker continuity stay
   * unchanged. Workers read their own scope plus their owner's scope, never any other. */
  constructor(private readonly open: () => Promise<MemoryProvider>, private readonly scope: (key: string) => string = key => key) {}
  private owner(context: MemoryContext): MemoryContext | undefined {
    const sessionKey = typeof context?.sessionKey === "string" ? this.scope(context.sessionKey) : context?.sessionKey;
    return sessionKey === context?.sessionKey ? undefined : { ...context, sessionKey };
  }
  private async target(p: MemoryProvider, context: MemoryContext, id: string): Promise<MemoryContext> {
    const owner = this.owner(context);
    return owner && !(await p.get(context, id)) ? owner : context;
  }

  get capabilities(): MemoryProvider["capabilities"] {
    return this.current?.capabilities ?? { semantic: false, revisions: true };
  }

  private async call<T>(run: (provider: MemoryProvider) => Promise<T>): Promise<T> {
    if (this.closed || this.changing || !this.current) throw Error("Memory provider unavailable");
    const provider = this.current;
    this.users++;
    try { return await run(provider); }
    finally { if (--this.users === 0) { this.drained?.(); this.drained = undefined; } }
  }

  private async retire(): Promise<void> {
    if (this.users) await new Promise<void>(resolve => { this.drained = resolve; });
    const provider = this.current;
    this.current = undefined;
    if (provider) {
      try { await provider.close(); }
      catch { this.cleanupFailed = true; throw Error("Memory provider cleanup failed; restart required"); }
    }
  }

  /** Coalesced health check and exclusive reconnect; failed cleanup forbids reopening. */
  ensureConnected(): Promise<void> {
    if (this.closed || this.cleanupFailed) return Promise.reject(Error("Memory provider lifecycle unavailable; restart required"));
    return this.connecting ??= this.connect().finally(() => { this.connecting = undefined; });
  }

  private async connect(): Promise<void> {
    if (this.current) {
      try { await this.status(); return; } catch { /* drain before replacing */ }
    }
    this.changing = true;
    try {
      await this.retire();
      if (this.closed) return;
      const candidate = await this.open();
      // Stop may arrive while the trusted factory awaits; never publish afterwards.
      this.current = candidate;
      if (this.closed) await this.retire();
    } finally { this.changing = false; }
  }

  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = (async () => {
      await this.connecting?.catch(() => {});
      await this.retire();
      if (this.cleanupFailed) throw Error("Memory provider cleanup failed; restart required");
    })();
    return this.stopping;
  }

  put: MemoryProvider["put"] = (context, entry) =>
    this.call(p => p.put(entry?.kind === "operation" ? context : this.owner(context) ?? context, entry));
  get: MemoryProvider["get"] = (context, id) => this.call(async p => {
    const owner = this.owner(context);
    return (await p.get(context, id)) ?? (owner ? p.get(owner, id) : undefined);
  });
  search: MemoryProvider["search"] = (context, query, options) => this.call(async p => {
    const own = await p.search(context, query, options);
    const owner = this.owner(context);
    if (!owner) return own;
    const merged = [...own];
    for (const hit of await p.search(owner, query, options)) if (!merged.some(h => h.entry.id === hit.entry.id)) merged.push(hit);
    return merged.sort((a, b) => b.score - a.score).slice(0, options?.limit ?? 5);
  });
  revise: MemoryProvider["revise"] = (context, id, ...args) => this.call(async p => p.revise(await this.target(p, context, id), id, ...args));
  forget: MemoryProvider["forget"] = (context, id, ...args) => this.call(async p => p.forget(await this.target(p, context, id), id, ...args));
  status: MemoryProvider["status"] = () => this.call(p => p.status());
  reindex: MemoryProvider["reindex"] = () => this.call(p => p.reindex());
}
