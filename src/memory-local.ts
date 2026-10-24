import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemoryConfig, MemoryContext, MemoryEntry, MemoryHit, MemoryProvider, MemoryStatus, MemoryWrite } from "./memory.js";

/** Separate OS process: index work cannot block the agent event loop. Linux flock owns writes. */
export class LocalMemory implements MemoryProvider {
  readonly capabilities;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private closed = false;
  private failure?: Error;
  private constructor(private readonly child: ChildProcess, config: MemoryConfig) {
    this.capabilities = { semantic: Boolean(config.embedding), revisions: true };
    child.on("message", (message: any) => {
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(Error(message.error)); else request.resolve(message.value);
    });
    const failed = () => {
      this.failure = Error("Memory worker unavailable; restart required");
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure); }
      this.pending.clear();
    };
    child.on("error", failed); child.on("exit", failed);
  }
  static async open(home: string, config: MemoryConfig): Promise<LocalMemory> {
    const dir = path.join(home, "memory");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const ext = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const child = spawn("flock", ["--no-fork", "--nonblock", path.join(dir, "writer.lock"), process.execPath,
      ...(ext === "ts" ? ["--import", "tsx"] : []), fileURLToPath(new URL(`./memory-worker.${ext}`, import.meta.url))], {
      stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env },
    });
    const client = new LocalMemory(child, config);
    try { await client.call("open", [dir, config]); } catch (err) { child.kill(); throw err; }
    return client;
  }
  private call(method: string, args: unknown[]): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(Error("Memory provider closed"));
    if (this.pending.size >= 64) return Promise.reject(Error("Memory worker queue full"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error("Memory request timed out; write outcome may be unknown, retry with same key")); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.send?.({ id, method, args }, (err) => {
        if (!err) return;
        clearTimeout(timer); this.pending.delete(id); reject(Error("Memory worker disconnected"));
      });
    });
  }
  put(context: MemoryContext, input: MemoryWrite): Promise<MemoryEntry> { return this.call("put", [context, input]); }
  get(context: MemoryContext, id: string): Promise<MemoryEntry | undefined> { return this.call("get", [context, id]); }
  search(context: MemoryContext, query: string, options?: { limit?: number; historical?: boolean }): Promise<MemoryHit[]> { return this.call("search", [context, query, options]); }
  revise(context: MemoryContext, id: string, revision: string, patch: Parameters<MemoryProvider["revise"]>[3]): Promise<MemoryEntry> { return this.call("revise", [context, id, revision, patch]); }
  forget(context: MemoryContext, id: string, revision: string): Promise<void> { return this.call("forget", [context, id, revision]); }
  status(): Promise<MemoryStatus> { return this.call("status", []); }
  reindex(): Promise<void> { return this.call("reindex", []); }
  async close(): Promise<void> {
    if (this.closed) return;
    try { await this.call("close", []); } finally {
      this.closed = true;
      if (this.child.exitCode === null && this.child.signalCode === null) await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.child.removeListener("exit", finish);
          resolve();
        };
        const timer = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
          finish();
        }, 2000);
        timer.unref();
        this.child.once("exit", finish);
        this.child.kill("SIGTERM");
      });
    }
  }
}
