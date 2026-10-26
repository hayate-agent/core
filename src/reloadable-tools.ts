import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { PluginHost, type PluginAPI, type PluginModule, type PluginTool } from "./plugins.js";

interface Generation { host: PluginHost; users: number; retired: boolean; }

/** Trusted tool-only ESM replacement. Public tool names/schemas remain fixed,
 * so existing SDK sessions can keep stable delegates. Not a sandbox.
 */
export class ReloadableTools {
  private current?: Generation;
  private changing = false;
  private closed = false;
  private attempts = 0;
  private fingerprint?: string;
  private refreshing?: Promise<void>;

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
    private readonly files: string[], private readonly log: (text: string) => void = () => {}) {}

  async reload(): Promise<void> {
    if (this.closed || this.changing) throw Error("Tool plugin reload unavailable");
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
      if (host.commands.size || host.channels.size || host.panels.size || host.compactions.size || host.memoryProviders.size || host.sessionProviders.size) throw Error("Reloadable plugins may register tools only");
      if (this.current) {
        if (host.tools.size !== this.tools.size) throw Error("Reload requires unchanged tool registrations");
        for (const [name,tool] of host.tools) {
          const previous = this.tools.get(name);
          if (!previous || previous.description !== tool.description || JSON.stringify(previous.parameters) !== JSON.stringify(tool.parameters)) throw Error("Reload requires unchanged tool schemas/descriptions");
        }
      }
      if (this.closed) throw Error("Tool plugins stopped during reload");
      const next: Generation = {host,users:0,retired:false};
      this.generations.add(next);
      const old = this.current;
      this.current = next;
      this.fingerprint = fingerprint;
      if (!old) for (const [name,tool] of host.tools) this.tools.set(name, Object.freeze({...tool,
        execute: async (input: Record<string,unknown>,context: {sessionKey:string;signal?:AbortSignal}) => {
          if (this.closed || !this.current) throw Error("Tool plugins stopped");
          const generation = this.current;
          generation.users++;
          try { return await generation.host.tools.get(name)!.execute(input,context); }
          finally { generation.users--; await this.retire(generation); }
        },
      }));
      if (old) { old.retired=true; await this.retire(old); }
    } catch (error) {
      if (this.current?.host !== host) await host.stop().catch(()=>this.log("Tool plugin candidate cleanup failed"));
      throw error;
    } finally { this.changing=false; }
  }

  private async retire(generation: Generation): Promise<void> {
    if (!generation.retired || generation.users) return;
    this.generations.delete(generation);
    await generation.host.stop().catch(()=>this.log("Retired tool plugin cleanup failed"));
  }

  async stop(): Promise<void> {
    this.closed=true;
    for (const generation of this.generations) { generation.retired=true; await this.retire(generation); }
  }
}
