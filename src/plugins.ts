import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Address, Channel, Inbound, SendMeta, TurnEvent } from "./types.js";

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
  start(deliver: (message: PluginMessage) => Promise<void>): Promise<void>;
  send(to: Address, text: string, meta?: SendMeta): Promise<void>;
  stop(budgetMs?: number): Promise<void>;
  turnEvent?(to: Address, event: TurnEvent): void;
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
    send: (to, text, meta) => channel.send(to, text, meta),
    stop: (budget) => channel.stop(budget),
    ...(channel.turnEvent ? { turnEvent: (to: Address, event: TurnEvent) => channel.turnEvent!(to, event) } : {}),
    ...(channel.typing ? { typing: (to: Address, on: boolean) => channel.typing!(to, on) } : {}),
  };
}

export interface PluginCommand {
  name: string;
  help: string;
  /** Default true. Explicit false permits ordinary channel users. */
  admin?: boolean;
  run(args: string, context: { sessionKey: string; sender?: string }): Promise<string | void>;
}

export interface PluginAPI {
  readonly version: 1;
  readonly agent: string;
  readonly home: string;
  readonly cwd: string;
  registerCommand(command: PluginCommand): void;
  registerChannel(channel: PluginChannel): void;
  /** Cleanup runs in reverse registration order, including failed initialization. */
  onStop(cleanup: () => Promise<void> | void): void;
}

export interface PluginModule {
  apiVersion: 1;
  activate(api: PluginAPI): Promise<void> | void;
}

/** Trusted, explicitly configured local ESM modules. This is not a code sandbox. */
export class PluginHost {
  readonly commands = new Map<string, PluginCommand>();
  readonly channels = new Map<string, Channel>();
  private cleanups: Array<() => Promise<void> | void> = [];
  private closed = false;

  async load(files: string[], context: Pick<PluginAPI, "agent" | "home" | "cwd">, reserved: Iterable<string>, reservedChannels: Iterable<string> = ["console", "api", "matrix"]): Promise<void> {
    if (this.closed) throw new Error("Plugin host is closed");
    const names = new Set([...reserved, ...this.commands.keys()]);
    const channelNames = new Set([...reservedChannels, ...this.channels.keys()]);
    try {
      for (const file of files) {
        const location = path.resolve(context.home, file);
        const module = (await import(pathToFileURL(location).href)).default as PluginModule;
        if (!module || module.apiVersion !== 1 || typeof module.activate !== "function") throw new Error(`Invalid plugin API: ${location}`);
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
              this.commands.set(command.name, Object.freeze({ ...command, admin: command.admin ?? true }));
            },
            registerChannel: (channel: PluginChannel) => {
              if (!registering) throw new Error("Plugin registration is closed");
              if (!channel || typeof channel.name !== "string" || !/^[a-z][a-z0-9_-]*$/.test(channel.name) ||
                  [channel.start, channel.send, channel.stop].some((fn) => typeof fn !== "function") ||
                  [channel.turnEvent, channel.typing].some((fn) => fn !== undefined && typeof fn !== "function")) throw new Error("Invalid plugin channel");
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
    } catch (err) {
      await this.stop().catch(() => {});
      this.commands.clear();
      this.channels.clear();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.splice(0).reverse()) {
      try { await cleanup(); } catch (err) { errors.push(err); }
    }
    if (errors.length) throw new AggregateError(errors, "Plugin cleanup failed");
  }
}
