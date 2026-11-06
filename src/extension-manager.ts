// SPDX-License-Identifier: Apache-2.0
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PluginHost, type PluginAPI, type PluginModule, type PluginCommand, type PluginPanel } from "./plugins.js";
import type { Harness } from "./harness.js";
import type { SettingsService } from "./settings.js";
import type { Policy } from "./policies.js";

interface Generation { host: PluginHost; commands: Map<string, PluginCommand>; panels: Map<string, PluginPanel>;
  policies: Map<string, Readonly<Policy>>; users: number; retired: boolean; release?: () => void; drained?: Promise<void> }
/** Trusted runtime modules limited to dynamically routed commands, panels and optional policies. */
export class ExtensionManager {
  private active = new Map<string, Generation>();
  private pending = new Map<string, number>();
  private errors = new Map<string, string>();
  private generation = 0;
  private flight?: Promise<void>;
  private closed = false;
  private stopped?: Promise<void>;
  private retired = new Set<Promise<void>>();
  private cleanupFailed = false;
  private failedHosts = new Set<PluginHost>();
  constructor(private boundary: Pick<Harness, "atIdleBoundary">, private target: PluginHost, private settings: SettingsService,
    private context: Pick<PluginAPI, "home" | "cwd" | "agent">, private reserved: readonly string[]) {}
  request(id: string): void {
    if (this.closed || this.cleanupFailed || !/^[a-z][a-z0-9-]*$/.test(id)) throw Error("Invalid extension request");
    this.pending.set(id, ++this.generation);
  }
  async load(): Promise<void> {
    for (const id of Object.keys(this.settings.desired().extensionPlugins ?? {})) this.request(id);
    await this.tick();
    if (this.errors.size || this.pending.size) throw Error("Initial extension activation failed");
  }
  private async invoke<T>(g: Generation, run: () => Promise<T>): Promise<T> {
    if (g.retired || this.closed) throw Error("Extension generation unavailable");
    g.users++;
    try { return await run(); }
    finally { if (--g.users === 0) g.release?.(); }
  }
  private retire(g: Generation): Promise<void> {
    g.retired = true;
    if (g.users) g.drained ??= new Promise<void>(resolve => { g.release = resolve; });
    const cleanup = (async () => { await g.drained; await g.host.stop(); })();
    this.retired.add(cleanup);
    void cleanup.then(() => this.retired.delete(cleanup), () => { this.cleanupFailed = true; });
    return cleanup;
  }
  private assertOwned(g: Generation): void {
    for (const [id, command] of g.commands) if (this.target.commands.get(id) !== command) throw Error("Command ownership changed");
    for (const [id, panel] of g.panels) if (this.target.panels.get(id) !== panel) throw Error("Panel ownership changed");
    for (const [id, policy] of g.policies) if (this.target.policies.isRequired(id) || this.target.policies.get(id) !== policy) throw Error("Policy ownership changed");
  }
  private detach(g: Generation): void {
    for (const [id, command] of g.commands) if (this.target.commands.get(id) === command) this.target.commands.delete(id);
    for (const [id, panel] of g.panels) if (this.target.panels.get(id) === panel) this.target.panels.delete(id);
    for (const [id, policy] of g.policies) if (this.target.policies.get(id) === policy && !this.target.policies.isRequired(id)) this.target.policies.remove(id);
  }
  private async prepare(module: string, previous?: Generation): Promise<Generation> {
    const url = pathToFileURL(path.resolve(this.context.home, module)); url.searchParams.set("generation", randomUUID());
    const host = new PluginHost();
    try {
      const module = (await import(url.href)).default as PluginModule;
      if (module?.apiVersion !== 1 || typeof module.activate !== "function") throw Error("Invalid extension module");
      await host.load([], this.context, [], [], [{ apiVersion: 1, activate: api => {
        const deny = () => { throw Error("Unsupported runtime extension registration"); };
        return module.activate(Object.freeze({ ...api, onStop: (cleanup: () => Promise<void> | void) => api.onStop(async () => {
          try { await cleanup(); } catch (error) { this.cleanupFailed = true; this.failedHosts.add(host); throw error; }
        }), registerTool: deny, registerChannel: deny,
          registerCompaction: deny, registerMemoryProvider: deny, registerSessionProvider: deny,
          registerMemoryOrchestrator: deny, registerReportProcessing: deny, registerDispatcher: deny }));
      } }]);
      if (previous) this.assertOwned(previous);
      if (host.tools.size || host.channels.size || host.compactions.size || host.memoryProviders.size || host.sessionProviders.size ||
          host.dispatchers.size) throw Error("Unsupported runtime extension registration");
      // Memory orchestrators are not a dynamic routing surface either.
      // The registry supplies an explicit count; no access to selected resources is needed.
      if (host.memoryOrchestration.size) throw Error("Unsupported runtime extension registration");
      for (const id of host.commands.keys()) if (this.reserved.includes(id) || (this.target.commands.has(id) && !previous?.commands.has(id))) throw Error("Command conflict");
      for (const id of host.panels.keys()) if (this.target.panels.has(id) && !previous?.panels.has(id)) throw Error("Panel conflict");
      for (const [id] of host.policies.entries()) if (this.target.policies.isRequired(id) || (this.target.policies.has(id) && !previous?.policies.has(id))) throw Error("Policy conflict");
      const g: Generation = { host, commands: new Map(), panels: new Map(), policies: new Map(), users: 0, retired: false };
      for (const [id, command] of host.commands) g.commands.set(id, Object.freeze({ ...command, run: (...args: Parameters<PluginCommand["run"]>) => this.invoke(g, () => command.run(...args)) }));
      for (const [id, panel] of host.panels) g.panels.set(id, Object.freeze({ ...panel, render: (...args: Parameters<PluginPanel["render"]>) => {
        if (g.retired || this.closed) return []; return panel.render(...args);
      } }));
      for (const [id, policy] of host.policies.entries()) {
        const wrapped: Policy = { id };
        if (policy.prepare) wrapped.prepare = (...args) => this.invoke(g, () => policy.prepare!(...args));
        if (policy.beforeTool) wrapped.beforeTool = (...args) => this.invoke(g, () => policy.beforeTool!(...args));
        if (policy.finish) wrapped.finish = (...args) => this.invoke(g, () => policy.finish!(...args));
        if (policy.assertAllowed) wrapped.assertAllowed = (...args) => this.invoke(g, () => policy.assertAllowed!(...args));
        g.policies.set(id, wrapped);
      }
      return g;
    } catch (error) {
      try { await host.stop(); } catch { this.cleanupFailed = true; this.failedHosts.add(host); }
      throw error;
    }
  }
  tick(): Promise<void> {
    if (this.closed || this.cleanupFailed) return Promise.resolve();
    if (this.flight) return this.flight;
    const flight = this.activate(); this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = undefined; }).catch(() => {});
    return flight;
  }
  private async activate(): Promise<void> {
    for (const [id, version] of [...this.pending]) {
      if (this.closed || this.cleanupFailed) break;
      let entered = false;
      try {
        await this.boundary.atIdleBoundary(async () => {
          entered = true;
          const old = this.active.get(id);
          const spec = this.settings.desired().extensionPlugins?.[id];
          let next: Generation | undefined;
          let detached = false;
          try {
            if (spec?.module && !spec.disabled) next = await this.prepare(spec.module, old);
            if (this.closed || this.cleanupFailed || this.pending.get(id) !== version) { if (next) await this.retire(next); return; }
            if (old) { this.assertOwned(old); this.detach(old); detached = true; }
            if (next) {
              for (const [name, command] of next.commands) this.target.commands.set(name, command);
              for (const [name, panel] of next.panels) this.target.panels.set(name, panel);
              for (const [name, policy] of next.policies) { this.target.policies.register(policy); next.policies.set(name, this.target.policies.get(name)!); }
              this.active.set(id, next);
            } else this.active.delete(id);
            this.errors.delete(id);
            this.settings.appliedPlugin("extensionPlugins", id, spec);
            if (old) void this.retire(old).catch(() => this.errors.set(id, "Retired extension cleanup failed; inspect local module/restart"));
          } catch {
            if (next && this.active.get(id) !== next) this.detach(next);
            if (detached && old) {
              for (const [name, command] of old.commands) this.target.commands.set(name, command);
              for (const [name, panel] of old.panels) this.target.panels.set(name, panel);
              for (const [name, policy] of old.policies) {
                if (!this.target.policies.has(name)) this.target.policies.register(policy);
                old.policies.set(name, this.target.policies.get(name)!);
              }
            }
            if (next && this.active.get(id) !== next) await this.retire(next).catch(() => {});
            this.errors.set(id, this.cleanupFailed ? "Extension cleanup failed; further activation blocked until restart" : "Extension activation failed; previous selection retained");
          }
        });
      } finally { if (entered && this.pending.get(id) === version) this.pending.delete(id); }
    }
  }
  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.closed = true; this.pending.clear();
    this.stopped = (async () => {
      await this.flight?.catch(() => {});
      for (const g of this.active.values()) { this.detach(g); void this.retire(g).catch(() => {}); }
      this.active.clear();
      const results = await Promise.allSettled([...this.retired]);
      if (this.cleanupFailed || this.failedHosts.size || results.some(r => r.status === "rejected")) throw Error("Extension cleanup failed");
    })();
    return this.stopped;
  }
  status(): string { return JSON.stringify({ active: [...this.active.keys()], pending: [...this.pending.keys()], retiring: this.retired.size, degraded: this.cleanupFailed, errors: Object.fromEntries(this.errors) }); }
}
