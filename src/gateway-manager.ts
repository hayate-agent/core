import path from "node:path";
import { missingModule } from "./optional-web-module.js";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import type { Address, InboundAttachment } from "./types.js";
import { verifyOutboundFile } from "./outbound-files.js";
import type { Harness } from "./harness.js";
import type { SettingsService } from "./settings.js";
import type { GatewayOverride } from "./gateway-provider.js";
import type { GatewayFactoryContext, GatewayInstance, GatewayModule } from "./gateway-provider.js";

/** Independently versioned trusted ESM gateway factories. Not a plugin sandbox. */
export class GatewayManager {
  private readonly active = new Map<string, GatewayInstance>();
  private readonly pending = new Map<string, { instance?: GatewayInstance; label: string; spec?: GatewayOverride }>();
  private readonly errors = new Map<string, string>();
  private changing = false;
  private preparing = 0;
  private readonly supported = new WeakSet<GatewayInstance>();
  // replaceGateway can restore the old channel after failed candidate cleanup.
  // Its rejection cannot prove that all candidate resources have stopped.
  private uncertainCleanup = false;
  updateBlockers(): string[] {
    const blockers: string[] = [];
    if (this.uncertainCleanup) blockers.push("gateway cleanup unverified; runtime owner reconciliation required");
    if (this.preparing || this.changing || this.pending.size) blockers.push("gateway transition");
    for (const [name, instance] of this.active) {
      if (!this.supported.has(instance)) blockers.push(`unsupported update owner: gateway ${name}`);
    }
    return blockers;
  }
  private adoptedHome?: import("./types.js").Address;
  /** Only replace a default we adopted ourselves; explicit operator routes win. */
  private reconcileHome(): void {
    if (this.harness.home !== undefined && this.harness.home !== this.adoptedHome) return;
    const home = [...this.active.values()].find(instance => instance.home)?.home;
    this.harness.home = home;
    this.adoptedHome = home;
  }
  constructor(private readonly harness: Harness, private readonly settings: SettingsService,
    private readonly context: GatewayFactoryContext, private readonly baseline: Record<string, string>) {}
  private async prepare(name: string, startup = false): Promise<GatewayInstance | undefined> {
    if (["console", "api", "subagents", "dispatch"].includes(name)) throw Error("Reserved gateway ID");
    const override = this.settings.desired().gatewayPlugins?.[name];
    if (override?.disabled) return undefined;
    const location = override?.module ?? this.baseline[name];
    if (!location) return undefined;
    const url = location.startsWith("file:") ? new URL(location) : pathToFileURL(path.resolve(this.context.home, location));
    if (url.protocol !== "file:") throw Error("Only explicitly installed local ESM gateway modules are supported");
    if (startup && name === "webui" && await missingModule(url)) {
      this.errors.set(name, "Optional Web gateway entrypoint is not installed; other agent channels remain available");
      console.error("[gateway] Optional Web gateway is not installed; continuing without it");
      return undefined;
    }
    url.searchParams.set("activation", randomUUID());
    const module = (await import(url.href)).default as GatewayModule;
    if (module?.apiVersion !== 1 || typeof module.create !== "function") throw Error("Unsupported gateway module");
    const instance = await module.create(this.context);
    if (instance && (instance.channel?.name !== name || typeof instance.channel.start !== "function" || typeof instance.channel.stop !== "function" || typeof instance.channel.send !== "function")) throw Error("Invalid gateway instance");
    if (instance && (!override?.module || module.updateAdmission === "foreground-owned")) this.supported.add(instance);
    return instance;
  }
  async load(): Promise<void> {
    for (const name of new Set([...Object.keys(this.baseline), ...Object.keys(this.settings.desired().gatewayPlugins ?? {})])) {
      const instance = await this.prepare(name, true);
      if (instance) { this.harness.addChannel(instance.channel); this.active.set(name, instance); this.reconcileHome(); }
    }
  }
  get approvers(): string[] { return [...new Set([...this.active.values()].flatMap((x) => x.approvers ?? []))]; }
  get remote(): boolean { return this.active.size > 0; }
  /** Live host facts only: no credentials, module paths or desired-but-inactive modules. */
  messagingCapabilities() {
    return [...this.active].map(([gateway, instance]) => ({ gateway,
      messaging: instance.channel.messaging?.describe() ?? null }));
  }
  async destinations(gateway: string, limit: number, cursor?: string, signal?: AbortSignal) {
    return this.harness.withForegroundWork(async () => {
      const messaging = this.active.get(gateway)?.channel.messaging;
      if (!messaging?.destinations) throw Error("Gateway destination discovery is unavailable");
      signal?.throwIfAborted();
      return messaging.destinations({ limit, cursor }, signal);
    });
  }
  async sendMessage(sessionKey: string, requestId: string, to: Address, text: string, signal?: AbortSignal, attachment?: InboundAttachment): Promise<void> {
    return this.harness.withForegroundWork(async () => {
      const info = this.active.get(to.channel)?.channel.messaging?.describe();
      if (!info?.text || info.connected === false || (attachment && !info.files)) throw Error("Gateway messaging is unavailable or disconnected");
      if (attachment) await verifyOutboundFile(this.context.home, sessionKey, attachment);
      signal?.throwIfAborted();
      const deliveryId = "message:" + createHash("sha256").update(JSON.stringify(attachment
        ? [sessionKey, requestId, to, text, attachment] : [sessionKey, requestId, to, text])).digest("hex");
      // One transport attempt, through the same delivery/activation fence as replies.
      // Stable ID is a provider hint, not an exactly-once or automatic replay claim.
      await this.harness.deliver(to, text, { deliveryId,
        ...(attachment ? { attachments: [attachment], attachmentSessionKey: sessionKey } : {}) });
    });
  }
  private readonly generations = new Map<string, number>();
  async request(name: string): Promise<void> {
    const spec = this.settings.desired().gatewayPlugins?.[name];
    const generation = (this.generations.get(name) ?? 0) + 1;
    this.generations.set(name, generation);
    this.pending.delete(name);
    this.errors.delete(name);
    // Prepare without touching the running adapter. Modules must not start receiving in create().
    let instance: GatewayInstance | undefined;
    this.preparing++;
    try {
      instance = await this.prepare(name);
    } catch (error) {
      if (this.generations.get(name) === generation) {
        this.errors.set(name, "Preparation failed; running gateway unchanged by this request");
      }
      throw error;
    } finally { this.preparing--; }
    if (this.generations.get(name) !== generation) return;
    this.pending.set(name, { instance, label: spec?.module ?? "baseline", spec });
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
          } else this.active.delete(name);
          this.reconcileHome();
          if (this.pending.get(name) === change) this.pending.delete(name);
          if (this.generations.get(name) === generation) {
            this.errors.delete(name);
            this.settings.appliedPlugin("gatewayPlugins", name, change.spec);
          }
        } catch (err) {
          const message = (err as Error).message;
          if (message.includes("idle turn boundary")) continue;
          this.uncertainCleanup = true;
          if (this.pending.get(name) === change) this.pending.delete(name);
          if (this.generations.get(name) === generation) {
            this.errors.set(name, "Activation failed; inspect local logs and previous gateway health");
          }
        }
      }
    } finally { this.changing = false; }
  }
  status(): string { return JSON.stringify({ active: [...this.active.keys()], pending: [...this.pending.keys()], errors: Object.fromEntries(this.errors) }); }

}
