import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PluginHost, type PluginAPI, type PluginModule, type PluginTool } from "./plugins.js";

interface Generation { host: PluginHost; users: number; retired: boolean; drained?: Promise<void>; release?: () => void; cleanup?: Promise<void> }

/** Combine a live catalog with startup registrations without hiding another owner's tools. */
export function composeToolCatalog(startup: ReadonlyMap<string, PluginTool>, owned: ReadonlyMap<string, PluginTool>, current: ReadonlyMap<string, PluginTool>): PluginTool[] {
  for (const [name, tool] of owned) {
    if (startup.get(name) !== tool) throw Error("Startup tool ownership changed; restart required");
  }
  for (const name of current.keys()) {
    if (startup.has(name) && !owned.has(name)) throw Error("Tool catalog conflicts with startup tool");
  }
  return [...startup.values()].filter(tool => owned.get(tool.name) !== tool).concat([...current.values()]);
}

/** Trusted tool-only ESM replacement. Dynamic catalogs require session reconciliation.
 * Same-signature delegates remain stable. Not a sandbox.
 */
export class ReloadableTools {
  private current?: Generation;
  private changing = false;
  private closed = false;
  private attempts = 0;
  private fingerprint?: string;
  private refreshing?: Promise<void>;
  private loading?: Promise<void>;
  private stopping?: Promise<void>;
  private cleanupFailed = false;

  private async snapshot(): Promise<string> {
    const hash = createHash("sha256");
    for (const file of this.files) hash.update(await readFile(path.resolve(this.context.home,file))).update("\0");
    return hash.digest("hex");
  }

  /** Coalesce checks across conversations; no background watcher or mid-turn reload. */
  refresh(): Promise<void> {
    return this.refreshing ??= (async () => {
      const fingerprint = await this.snapshot();
      if (fingerprint !== this.fingerprint) await this.reload();
    })().finally(() => { this.refreshing = undefined; });
  }

  get loadAttempts(): number { return this.attempts; }
  get liveGenerations(): number { return this.generations.size; }
  readonly tools = new Map<string, PluginTool>();
  private readonly generations = new Set<Generation>();

  constructor(private readonly context: Pick<PluginAPI,"home"|"cwd"|"agent">,
    private readonly files: string[], private readonly log: (text: string) => void = () => {}, private readonly dynamicCatalog = false, private readonly validateCatalog: (tools: ReadonlyMap<string, PluginTool>) => void = () => {}) {}

  reload(): Promise<void> {
    if (this.closed || this.changing || this.cleanupFailed) return Promise.reject(Error("Tool plugin reload unavailable"));
    const loading = this.load(); this.loading = loading;
    void loading.finally(() => { if (this.loading === loading) this.loading = undefined; }).catch(() => {});
    return loading;
  }
  private async load(): Promise<void> {
    if (this.closed || this.changing || this.cleanupFailed) throw Error("Tool plugin reload unavailable");
    if (this.attempts >= 50) throw Error("Tool plugin reload budget exhausted; restart required");
    this.attempts++;
    this.changing = true;
    const host = new PluginHost();
    try {
      const fingerprint = await this.snapshot();
      const modules: PluginModule[] = [];
      for (const file of this.files) {
        const url = pathToFileURL(path.resolve(this.context.home,file));
        url.searchParams.set("generation",randomUUID());
        modules.push((await import(url.href)).default);
      }
      await host.load([],this.context,[],[],modules);
      if (host.commands.size || host.channels.size || host.panels.size || host.compactions.size || host.memoryProviders.size || host.sessionProviders.size || host.policies.entries().length || host.memoryOrchestration.size || host.reportProcessing.size || host.dispatchers.size) throw Error("Reloadable plugins may register tools only");
      if (this.current && !this.dynamicCatalog) {
        if (host.tools.size !== this.tools.size) throw Error("Reload requires unchanged tool registrations");
        for (const [name,tool] of host.tools) {
          const previous = this.tools.get(name);
          if (!previous || previous.description !== tool.description || JSON.stringify(previous.parameters) !== JSON.stringify(tool.parameters)) throw Error("Reload requires unchanged tool schemas/descriptions");
        }
      }
      this.validateCatalog(host.tools);
      if (this.closed) throw Error("Tool plugins stopped during reload");
      const next: Generation = {host,users:0,retired:false};
      this.generations.add(next);
      const old = this.current;
      this.current = next;
      this.fingerprint = fingerprint;
      const prior = new Map(this.tools);
      this.tools.clear();
      for (const [name,tool] of host.tools) {
        const signature = JSON.stringify([tool.description, tool.parameters]);
        const previous = prior.get(name);
        if (previous && JSON.stringify([previous.description, previous.parameters]) === signature) { this.tools.set(name, previous); continue; }
        this.tools.set(name, Object.freeze({...tool,
        execute: async (input: Record<string,unknown>,context: {sessionKey:string;signal?:AbortSignal}) => {
          if (this.closed || !this.current) throw Error("Tool plugins stopped");
          const generation = this.current;
          const selected = generation.host.tools.get(name);
          if (!selected || JSON.stringify([selected.description, selected.parameters]) !== signature) throw Error("Tool catalog changed; refresh session before invoking");
          generation.users++;
          try { return await selected.execute(input,context); }
          finally { if (--generation.users === 0) generation.release?.(); await this.retire(generation); }
        },
      }));
      }
      if (old) { old.retired=true; await this.retire(old); }
    } catch (error) {
      if (this.current?.host !== host) await host.stop().catch(()=>{ this.cleanupFailed = true; this.log("Tool plugin candidate cleanup failed"); });
      throw error;
    } finally { this.changing=false; }
  }

  private async retire(generation: Generation): Promise<void> {
    if (!generation.retired || generation.users) return;
    generation.cleanup ??= generation.host.stop().then(() => { this.generations.delete(generation); }, () => {
      this.cleanupFailed = true; this.log("Retired tool plugin cleanup failed");
    });
    await generation.cleanup;
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closed=true;
    this.stopping = (async () => {
      await this.loading?.catch(() => {});
      for (const generation of this.generations) {
        generation.retired=true;
        if (generation.users) await (generation.drained ??= new Promise<void>(resolve => { generation.release = resolve; }));
        await this.retire(generation);
      }
      if (this.cleanupFailed) throw Error("Tool plugin cleanup failed; restart required");
    })();
    return this.stopping;
  }
}
