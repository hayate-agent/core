// SPDX-License-Identifier: Apache-2.0
import type { MemoryProvider } from "./memory.js";

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

  constructor(private readonly open: () => Promise<MemoryProvider>) {}

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

  put: MemoryProvider["put"] = (...args) => this.call(p => p.put(...args));
  get: MemoryProvider["get"] = (...args) => this.call(p => p.get(...args));
  search: MemoryProvider["search"] = (...args) => this.call(p => p.search(...args));
  revise: MemoryProvider["revise"] = (...args) => this.call(p => p.revise(...args));
  forget: MemoryProvider["forget"] = (...args) => this.call(p => p.forget(...args));
  status: MemoryProvider["status"] = () => this.call(p => p.status());
  reindex: MemoryProvider["reindex"] = () => this.call(p => p.reindex());
}
