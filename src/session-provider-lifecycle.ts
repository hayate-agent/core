import type { SessionProvider } from "./sessions.js";

/** Owns one startup-selected backend. Session leases pin checkpoint closures to it;
 * shutdown closes it only after sessions and direct operations have drained.
 * This is not datastore migration or runtime provider selection.
 */
export class SessionProviderLifecycle implements SessionProvider {
  private users = 0;
  private sessions = 0;
  private closed = false;
  private stopping?: Promise<void>;
  private drained?: () => void;
  constructor(private readonly provider: SessionProvider) {}

  /** A lease is held from runtime open through its final checkpoint/dispose. */
  retain(): { provider: SessionProvider; release(): void } {
    if (this.closed) throw Error("Session provider stopping");
    this.sessions++;
    let released = false;
    const call = <T>(run: () => Promise<T>) => {
      if (released) return Promise.reject(Error("Session provider lease released"));
      return this.call(run, true);
    };
    const provider: SessionProvider = {
      load: (...a) => call(() => this.provider.load(...a)), active: (...a) => call(() => this.provider.active(...a)),
      bind: (...a) => call(() => this.provider.bind(...a)), create: (...a) => call(() => this.provider.create(...a)),
      save: (...a) => call(() => this.provider.save(...a)), list: (...a) => call(() => this.provider.list(...a)),
    };
    return { provider, release: () => { if (!released) { released = true; this.sessions--; this.notify(); } } };
  }
  private notify(): void { if (!this.users && !this.sessions) { this.drained?.(); this.drained = undefined; } }
  private async call<T>(run: () => Promise<T>, leased = false): Promise<T> {
    if (this.closed && !leased) throw Error("Session provider stopping");
    this.users++;
    try { return await run(); } finally { this.users--; this.notify(); }
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.stopping = (async () => {
      if (this.users || this.sessions) await new Promise<void>(resolve => { this.drained = resolve; });
      await this.provider.close?.();
    })();
    return this.stopping;
  }
  load: SessionProvider["load"] = (...args) => this.call(() => this.provider.load(...args));
  active: SessionProvider["active"] = (...args) => this.call(() => this.provider.active(...args));
  bind: SessionProvider["bind"] = (...args) => this.call(() => this.provider.bind(...args));
  create: SessionProvider["create"] = (...args) => this.call(() => this.provider.create(...args));
  save: SessionProvider["save"] = (...args) => this.call(() => this.provider.save(...args));
  list: SessionProvider["list"] = (...args) => this.call(() => this.provider.list(...args));
}
