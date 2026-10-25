import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type { Harness } from "./harness.js";
import type { SettingsService } from "./settings.js";
import type { GatewayFactoryContext, GatewayInstance, GatewayModule } from "./gateway-provider.js";
import type { PluginModule } from "./plugins.js";

/** Independently versioned trusted ESM gateway factories. Not a plugin sandbox. */
export class GatewayManager {
  private readonly active = new Map<string, GatewayInstance>();
  private readonly pending = new Map<string, { instance?: GatewayInstance; label: string }>();
  private readonly errors = new Map<string, string>();
  private changing = false;
  constructor(private readonly harness: Harness, private readonly settings: SettingsService,
    private readonly context: GatewayFactoryContext, private readonly baseline: Record<string, string>) {}
  private async prepare(name: string): Promise<GatewayInstance | undefined> {
    if (["console", "api", "subagents", "dispatch"].includes(name)) throw Error("Reserved gateway ID");
    const override = this.settings.effective().gatewayPlugins?.[name];
    if (override?.disabled) return undefined;
    const location = override?.module ?? this.baseline[name];
    if (!location) throw Error("No gateway module configured");
    const url = location.startsWith("file:") ? new URL(location) : pathToFileURL(path.resolve(this.context.home, location));
    if (url.protocol !== "file:") throw Error("Only explicitly installed local ESM gateway modules are supported");
    url.searchParams.set("activation", randomUUID());
    const module = (await import(url.href)).default as GatewayModule;
    if (module?.apiVersion !== 1 || typeof module.create !== "function") throw Error("Unsupported gateway module");
    const instance = await module.create(this.context);
    if (instance && (instance.channel?.name !== name || typeof instance.channel.start !== "function" || typeof instance.channel.stop !== "function" || typeof instance.channel.send !== "function")) throw Error("Invalid gateway instance");
    return instance;
  }
  async load(): Promise<void> {
    for (const name of new Set([...Object.keys(this.baseline), ...Object.keys(this.settings.effective().gatewayPlugins ?? {})])) {
      const instance = await this.prepare(name);
      if (instance) { this.harness.addChannel(instance.channel); this.active.set(name, instance); this.harness.home ??= instance.home; }
    }
  }
  get approvers(): string[] { return [...new Set([...this.active.values()].flatMap((x) => x.approvers ?? []))]; }
  get remote(): boolean { return this.active.size > 0; }
  private readonly generations = new Map<string, number>();
  async request(name: string): Promise<void> {
    const generation = (this.generations.get(name) ?? 0) + 1;
    this.generations.set(name, generation);
    this.pending.delete(name);
    this.errors.delete(name);
    // Prepare without touching the running adapter. Modules must not start receiving in create().
    let instance: GatewayInstance | undefined;
    try {
      instance = await this.prepare(name);
    } catch (error) {
      if (this.generations.get(name) === generation) {
        this.errors.set(name, "Preparation failed; running gateway unchanged by this request");
      }
      throw error;
    }
    if (this.generations.get(name) !== generation) return;
    this.pending.set(name, { instance, label: this.settings.effective().gatewayPlugins?.[name]?.module ?? "baseline" });
  }
  async tick(): Promise<void> {
    if (this.changing) return;
    this.changing = true;
    try {
      // Snapshot the boundary: deleting/reinserting a name during an await must
      // not activate its newer request in the same iteration.
      for (const [name, change] of [...this.pending]) {
        if (this.pending.get(name) !== change) continue;
        const generation = this.generations.get(name);
        try {
          await this.harness.replaceGateway(name, change.instance?.channel);
          if (change.instance) {
            this.active.set(name, change.instance);
            this.harness.home ??= change.instance.home;
          } else this.active.delete(name);
          if (this.pending.get(name) === change) this.pending.delete(name);
          if (this.generations.get(name) === generation) this.errors.delete(name);
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes("idle turn boundary")) continue;
          if (this.pending.get(name) === change) this.pending.delete(name);
          if (this.generations.get(name) === generation) {
            this.errors.set(name, "Activation failed; inspect local logs and previous gateway health");
          }
        }
      }
    } finally { this.changing = false; }
  }
  status(): string { return JSON.stringify({ active: [...this.active.keys()], pending: [...this.pending.keys()], errors: Object.fromEntries(this.errors) }); }
  plugin(): PluginModule {
    return { apiVersion: 1, activate: (api) => {
      api.registerCommand({ name: "gateway-plugin", help: "Runtime gateway modules: status | reload <id> | use <id> <module-path> | disable <id> | baseline <id>", run: async (args) => {
        const [action = "status", name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status") return this.status();
        if (!name || !/^[a-z][a-z0-9_-]*$/.test(name) || ["console", "api", "subagents", "dispatch"].includes(name)) throw Error("Invalid gateway ID");
        if (action === "use" && rest.length === 1) await this.settings.setGatewayPlugin(name, { module: rest[0] });
        else if (action === "disable" && !rest.length) await this.settings.setGatewayPlugin(name, { disabled: true });
        else if (action === "baseline" && !rest.length) await this.settings.setGatewayPlugin(name, undefined);
        else if (action !== "reload" || rest.length) throw Error("Use status|reload <id>|use <id> <path>|disable <id>|baseline <id>");
        await this.request(name);
        return `Gateway ${name}: configuration saved, activation pending idle boundary. /gateway-plugin status reports active/pending/errors.`;
      } });
    } };
  }
}
