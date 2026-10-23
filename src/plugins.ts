import path from "node:path";
import { pathToFileURL } from "node:url";

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
  private cleanups: Array<() => Promise<void> | void> = [];
  private closed = false;

  async load(files: string[], context: Pick<PluginAPI, "agent" | "home" | "cwd">, reserved: Iterable<string>): Promise<void> {
    if (this.closed) throw new Error("Plugin host is closed");
    const names = new Set([...reserved, ...this.commands.keys()]);
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
              if (!command || !/^[a-z][a-z0-9_-]*$/.test(command.name) || typeof command.help !== "string" || typeof command.run !== "function" ||
                  (command.admin !== undefined && typeof command.admin !== "boolean")) throw new Error("Invalid plugin command");
              if (names.has(command.name)) throw new Error(`Command conflict: /${command.name}`);
              names.add(command.name);
              this.commands.set(command.name, Object.freeze({ ...command, admin: command.admin ?? true }));
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
