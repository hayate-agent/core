import path from "node:path";
import { MemoryOrchestrationRegistry, type MemoryOrchestrator } from "./memory-orchestration.js";
import { PolicyRegistry, type Policy } from "./policies.js";
import type { DispatcherStrategy } from "./dispatcher.js";
import type { MemoryProviderFactory } from "./memory.js";
import type { CompactionStrategy } from "./compaction.js";
import type { SessionProviderFactory } from "./sessions.js";
import { pathToFileURL } from "node:url";
import type { Address, Channel, Inbound, SendMeta, TurnEvent } from "./types.js";

export interface PluginTool {
  /** Must start with plugin_ to avoid overriding runtime tools. */
  name: string;
  description: string;
  parameters: { type: "object"; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown };
  execute(input: Record<string, unknown>, context: { sessionKey: string; signal?: AbortSignal }): Promise<string>;
}

/** Plain text only: no terminal escape sequences or focus/input ownership. */
export interface PluginPanel {
  name: string;
  render(context: { agent: string }): string[];
}

/** Remote transport input; routing/source fields are owned by the host. */
export interface PluginMessage {
  session: string;
  target: string;
  text: string;
  sender?: string;
  id?: string;
  thread?: string;
}

export interface PluginChannel {
  readonly name: string;
  /** Implements SendMeta.progressId resolution, ordered edits and final replacement. */
  readonly editableProgress?: boolean;
  progressEnabled?(): boolean;
  configureGateway?(settings: import("./gateway-settings.js").GatewaySettings): void;
  turnStatus?(to: Address, input: Inbound, status: "started" | "completed" | "failed" | "cancelled"): Promise<void>;
  start(deliver: (message: PluginMessage) => Promise<void>): Promise<void>;
  send(to: Address, text: string, meta?: SendMeta): Promise<void>;
  stop(budgetMs?: number): Promise<void>;
  turnEvent?(to: Address, event: TurnEvent, input?: Inbound): void;
  taskActivity?(to: Address, event: import("./activity.js").ActivityEvent, input: Inbound): void;
  typing?(to: Address, on: boolean): Promise<void>;
}

/** Constrain untrusted transport metadata, even though the plugin code itself is trusted. */
function wrapChannel(channel: PluginChannel): Channel {
  const name = channel.name;
  return {
    name,
    start: (deliver) => channel.start(async (message) => {
      if (!message || typeof message.session !== "string" || !message.session ||
          typeof message.target !== "string" || !message.target || typeof message.text !== "string" ||
          [message.sender, message.id, message.thread].some((v) => v !== undefined && typeof v !== "string")) {
        throw new Error(`Invalid message from plugin channel ${name}`);
      }
      const input: Inbound = {
        source: "channel", text: message.text,
        sessionKey: `plugin:${name}:${message.session}`,
        sender: message.sender,
        id: message.id === undefined ? undefined : `plugin:${name}:${message.id}`,
        replyTo: { channel: name, target: message.target, thread: message.thread },
      };
      await deliver(input);
    }),
    editableProgress: channel.editableProgress === true,
    ...(channel.progressEnabled ? { progressEnabled: () => channel.progressEnabled!() } : {}),
    send: (to, text, meta) => channel.send(to, text, meta),
    stop: (budget) => channel.stop(budget),
    ...(channel.configureGateway ? { configureGateway: (settings: import("./gateway-settings.js").GatewaySettings) => channel.configureGateway!(settings) } : {}),
    ...(channel.turnStatus ? { turnStatus: (to: Address, input: Inbound, status: "started" | "completed" | "failed" | "cancelled") => channel.turnStatus!(to, input, status) } : {}),
    ...(channel.turnEvent ? { turnEvent: (to: Address, event: TurnEvent, input?: Inbound) => channel.turnEvent!(to, event, input) } : {}),
    ...(channel.taskActivity ? { taskActivity: (to: Address, event: import("./activity.js").ActivityEvent, input: Inbound) => channel.taskActivity!(to, event, input) } : {}),
    ...(channel.typing ? { typing: (to: Address, on: boolean) => channel.typing!(to, on) } : {}),
  };
}

export interface PluginWidget {
  /** Synchronous terminal component, rendered inside the bounded dialog area. */
  render(width: number): string[];
  handleInput(data: string): { value: string } | { cancel: true } | void;
  invalidate?(): void;
}

export interface PluginUI {
  prompt(message: string, secret?: boolean): Promise<string>;
  select(message: string, choices: Array<{ id: string; label: string }>): Promise<string>;
  confirm(message: string): Promise<boolean>;
  custom(message: string, widget: PluginWidget): Promise<string>;
  notify(message: string): void;
}

export interface PluginCommand {
  name: string;
  help: string;
  /** Default true. Explicit false permits ordinary channel users. */
  admin?: boolean;
  run(args: string, context: { sessionKey: string; sender?: string; ui?: PluginUI }): Promise<string | void>;
}

import { ReportProcessingRegistry, type ReportProcessing } from "./report-processing.js";

export interface PluginAPI {
  readonly version: 1;
  readonly agent: string;
  readonly home: string;
  readonly cwd: string;
  registerCommand(command: PluginCommand): void;
  registerChannel(channel: PluginChannel): void;
  registerTool(tool: PluginTool): void;
  registerSessionProvider(name: string, factory: SessionProviderFactory): void;
  registerMemoryProvider(name: string, factory: MemoryProviderFactory): void;
  registerMemoryOrchestrator(name: string, implementation: MemoryOrchestrator): void;
  registerReportProcessing(name: string, implementation: ReportProcessing): void;
  registerCompaction(name: string, strategy: CompactionStrategy): void;
  registerPanel(panel: PluginPanel): void;
  /** Register execution policy; activation is selected explicitly by host configuration. */
  registerDispatcher(strategy: DispatcherStrategy): void;
  /** Trusted optional hooks; ordered by registration, no implicit default veto. */
  registerPolicy(policy: Policy): () => void;
  /** Cleanup runs in reverse registration order, including failed initialization. */
  onStop(cleanup: () => Promise<void> | void): void;
}

export interface PluginModule {
  apiVersion: 1;
  /** Foreground work uses host ingress/tools; remaining resources use onStop cleanup. */
  updateAdmission?: "foreground-owned";
  activate(api: PluginAPI): Promise<void> | void;
}

/** Trusted, explicitly configured local ESM modules. This is not a code sandbox. */
export class PluginHost {
  private readonly unsupportedUpdateOwners = new Set<string>();
  updateBlockers(): string[] { return [...this.unsupportedUpdateOwners].map(owner => `unsupported update owner: ${owner}`); }
  readonly policies: PolicyRegistry;
  constructor(requiredPolicies: readonly string[] = []) { this.policies = new PolicyRegistry(requiredPolicies); }
  readonly commands = new Map<string, PluginCommand>();
  readonly channels = new Map<string, Channel>();
  readonly tools = new Map<string, PluginTool>();
  readonly compactions = new Map<string, CompactionStrategy>();
  readonly memoryOrchestration = new MemoryOrchestrationRegistry();
  readonly reportProcessing = new ReportProcessingRegistry();
  readonly memoryProviders = new Map<string, MemoryProviderFactory>();
  readonly sessionProviders = new Map<string, SessionProviderFactory>();
  readonly panels = new Map<string, PluginPanel>();
  readonly dispatchers = new Map<string, DispatcherStrategy>();
  private cleanups: Array<() => Promise<void> | void> = [];
  private closed = false;
  private closing = false;
  private loading?: Promise<void>;
  private stopping?: Promise<void>;

  load(files: string[], context: Pick<PluginAPI, "agent" | "home" | "cwd">, reserved: Iterable<string>, reservedChannels: Iterable<string> = ["console", "api", "matrix"], bundled: PluginModule[] = []): Promise<void> {
    if (this.closed || this.closing) return Promise.reject(new Error("Plugin host is closed"));
    if (this.loading) return Promise.reject(new Error("Plugin activation already in progress"));
    const loading = this.activate(files, context, reserved, reservedChannels, bundled);
    this.loading = loading;
    void loading.finally(() => { if (this.loading === loading) this.loading = undefined; }).catch(() => {});
    return loading;
  }

  private async activate(files: string[], context: Pick<PluginAPI, "agent" | "home" | "cwd">, reserved: Iterable<string>, reservedChannels: Iterable<string> = ["console", "api", "matrix"], bundled: PluginModule[] = []): Promise<void> {
    if (this.closed) throw new Error("Plugin host is closed");
    const names = new Set([...reserved, ...this.commands.keys()]);
    const channelNames = new Set([...reservedChannels, ...this.channels.keys()]);
    try {
      for (const source of [...bundled, ...files]) {
        const location = typeof source === "string" ? path.resolve(context.home, source) : "bundled core plugin";
        const module = typeof source === "string" ? (await import(pathToFileURL(location).href)).default as PluginModule : source;
        if (!module || module.apiVersion !== 1 || typeof module.activate !== "function") throw new Error(`Invalid plugin API: ${location}`);
        if (typeof source === "string" && module.updateAdmission !== "foreground-owned") this.unsupportedUpdateOwners.add(`plugin ${this.unsupportedUpdateOwners.size + 1}`);
        let registering = true;
        try {
          await module.activate(Object.freeze({
            version: 1 as const, ...context,
            registerCommand: (command: PluginCommand) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!command || typeof command.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(command.name) || typeof command.help !== "string" || typeof command.run !== "function" ||
                  (command.admin !== undefined && typeof command.admin !== "boolean")) throw new Error("Invalid plugin command");
              if (names.has(command.name)) throw new Error(`Command conflict: /${command.name}`);
              names.add(command.name);
              this.commands.set(command.name, Object.freeze({ ...command, admin: command.admin ?? true, run: command.run.bind(command) }));
            },
            registerPolicy: (policy: Policy) => {
              if (!registering) throw new Error("Plugin registration is closed");
              return this.policies.register(policy);
            },
            registerDispatcher: (strategy: DispatcherStrategy) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!strategy || typeof strategy.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(strategy.name) ||
                  !Number.isSafeInteger(strategy.version) || strategy.version < 1 || typeof strategy.replaySafe !== "boolean" ||
                  typeof strategy.execute !== "function") throw new Error("Invalid dispatcher strategy");
              if (strategy.name === "direct" || this.dispatchers.has(strategy.name)) throw new Error(`Dispatcher conflict: ${strategy.name}`);
              this.dispatchers.set(strategy.name, Object.freeze({
                name: strategy.name, version: strategy.version, replaySafe: strategy.replaySafe,
                execute: strategy.execute.bind(strategy),
              }));
            },
            registerCompaction: (name: string, strategy: CompactionStrategy) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name) || typeof strategy?.compact !== "function") throw new Error("Invalid compaction strategy");
              if (name === "native" || this.compactions.has(name)) throw new Error(`Compaction conflict: ${name}`);
              this.compactions.set(name, Object.freeze({ compact: strategy.compact.bind(strategy) }));
            },
            registerReportProcessing: (name: string, implementation: ReportProcessing) => {
              if (!registering) throw Error("Plugin registration is closed");
              this.reportProcessing.register(name, implementation);
            },
            registerMemoryOrchestrator: (name: string, implementation: MemoryOrchestrator) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (["default", "none"].includes(name)) throw new Error("Reserved memory orchestrator");
              this.memoryOrchestration.register(name, implementation);
            },
            registerMemoryProvider: (name: string, factory: MemoryProviderFactory) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!/^[a-z][a-z0-9_-]*$/.test(name) || name === "local" || typeof factory !== "function" || this.memoryProviders.has(name)) throw new Error("Invalid or duplicate memory provider");
              this.memoryProviders.set(name, factory);
            },
            registerSessionProvider: (name: string, factory: SessionProviderFactory) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (typeof name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(name) || typeof factory !== "function") throw new Error("Invalid session provider");
              if (name === "native" || name === "filesystem" || this.sessionProviders.has(name)) throw new Error(`Session provider conflict: ${name}`);
              this.sessionProviders.set(name, factory);
            },
            registerTool: (tool: PluginTool) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!tool || typeof tool.name !== "string" || !/^plugin_[a-z][a-z0-9_]*$/.test(tool.name) ||
                  typeof tool.description !== "string" || !tool.description.trim() || typeof tool.execute !== "function" ||
                  !tool.parameters || tool.parameters.type !== "object" || Array.isArray(tool.parameters)) throw new Error("Invalid plugin tool");
              if (this.tools.has(tool.name)) throw new Error(`Tool conflict: ${tool.name}`);
              this.tools.set(tool.name, Object.freeze({ ...tool, parameters: structuredClone(tool.parameters), execute: tool.execute.bind(tool) }));
            },
            registerPanel: (panel: PluginPanel) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!panel || typeof panel.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(panel.name) || typeof panel.render !== "function") throw new Error("Invalid plugin panel");
              if (this.panels.has(panel.name)) throw new Error(`Panel conflict: ${panel.name}`);
              this.panels.set(panel.name, Object.freeze({ ...panel, render: panel.render.bind(panel) }));
            },
            registerChannel: (channel: PluginChannel) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!channel || typeof channel.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(channel.name) ||
                  [channel.start, channel.send, channel.stop].some((fn) => typeof fn !== "function") ||
                  [channel.turnEvent, channel.taskActivity, channel.typing].some((fn) => fn !== undefined && typeof fn !== "function")) throw new Error("Invalid plugin channel");
              if (channelNames.has(channel.name)) throw new Error(`Channel conflict: ${channel.name}`);
              channelNames.add(channel.name);
              this.channels.set(channel.name, wrapChannel(channel));
            },
            onStop: (cleanup: () => Promise<void> | void) => {
              if (!registering || typeof cleanup !== "function") throw new Error("Invalid cleanup registration");
              this.cleanups.push(cleanup);
            },
          }));
        } finally { registering = false; }
      }
      this.policies.assertReady();
    } catch (err) {
      await this.dispose().catch(() => {});
      this.reportProcessing.clear();
      this.commands.clear();
      this.channels.clear();
      this.tools.clear();
      this.memoryProviders.clear();
      this.sessionProviders.clear();
      this.compactions.clear();
      this.panels.clear();
      this.dispatchers.clear();
      throw err;
    }
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true;
    this.stopping = (async () => {
      // An async activation owns its resources until it settles. Never acknowledge
      // shutdown while it can still register new resources after cleanup.
      await this.loading?.catch(() => {});
      await this.dispose();
    })();
    return this.stopping;
  }

  private async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.policies.clear();
    this.memoryOrchestration.clear();
    this.commands.clear();
    this.channels.clear();
    this.tools.clear();
    this.memoryProviders.clear();
    this.sessionProviders.clear();
    this.compactions.clear();
    this.panels.clear();
    this.dispatchers.clear();
    const errors: unknown[] = [];
    try { await this.reportProcessing.stop(); } catch (error) { errors.push(error); }
    this.reportProcessing.clear();
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new AggregateError(errors, "Plugin cleanup failed");
  }
}
