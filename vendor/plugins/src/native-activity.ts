import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeFileDurable } from "./durable.js";
import type { ActivityEvent } from "./activity.js";
import type { Address } from "./types.js";
import { labelOutput } from "./hashtags.js";

/** Serialized, bounded latest-value delivery. No runtime payloads enter this adapter. */
export class NativeActivityDelivery {
  private pending = new Map<string, { to: Address; text: string }>();
  private sent: Record<string, string> = {};
  private loaded = false;
  private stopped = false;
  private chain = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private tools = new Map<string, Map<string, string>>();
  private calls: Record<string, { to: Address; text: string }> = {};
  constructor(private file: string, private send: (to: Address, id: string, text: string) => Promise<void>, private delayMs = 1000) {}
  event(to: Address, event: ActivityEvent): void {
    const s = event.snapshot;
    const turn = createHash("sha256").update(JSON.stringify([to, s.id])).digest("hex");
    const active = this.tools.get(turn) ?? new Map<string, string>();
    if (event.tool) {
      const t = event.tool;
      if (t.state === "started") active.set(t.callId, t.name); else active.delete(t.callId);

    }
    for (const t of s.tools) {
      active.set(t.callId, t.name);

    }
    const terminal = ["completed", "failed", "cancelled"].includes(s.phase);
    if (terminal) {
      this.tools.delete(turn);
    } else if (this.tools.size < 128 || this.tools.has(turn)) this.tools.set(turn, active);
    const prefix = `${s.role === "worker" ? "Worker" : "Main"} · ${Math.floor(s.elapsedMs / 1000)}s`;
    const tool = event.tool;
    const detail = terminal ? s.phase
      : tool ? `Werkzeug ${tool.name}${active.size > 1 ? ` (+${active.size - 1} aktiv)` : ""}: ${tool.state}`
      : active.size ? `Werkzeug ${[...new Set(active.values())].join(", ")}: running`
      : `${s.phase} · ${s.activity}${event.kind === "alive" ? " · weiterhin aktiv (Host)" : ""}`;
    // One stable reference per turn: tool calls and host status replace each other.
    this.queue(turn, to, labelOutput(`${prefix} · ${detail}`, (s as typeof s & { outputTags?: string[] }).outputTags));
    if (tool?.state === "started") void this.flush().catch(() => undefined);
  }
  metadata(to: Address, id: string, state: string): void {
    if (!["ready", "running", "paused", "blocked", "completed", "cancelled", "waiting for operator"].includes(state)) return;
    this.queue(`dispatch:${createHash("sha256").update(id).digest("hex")}`, to, `Dispatcher: ${state}`);
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  private queue(id: string, to: Address, text: string): void {
    if (this.stopped) return;
    const key = createHash("sha256").update(JSON.stringify([to, id])).digest("hex");
    if (this.pending.size >= 512 && !this.pending.has(key)) return;
    this.pending.set(key, { to, text });
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, this.delayMs);
      this.timer.unref?.();
    }
  }
  flush(): Promise<void> {
    clearTimeout(this.timer); this.timer = undefined;
    const batch = [...this.pending];
    this.chain = this.chain.catch(() => undefined).then(async () => {
      if (!this.loaded) {
        try {
          const saved = JSON.parse(await readFile(this.file, "utf8"));
          this.sent = saved.sent ?? saved;
          // In-flight calls from a prior process cannot truthfully remain running.
          for (const [id, call] of Object.entries(saved.calls ?? {}) as Array<[string, { to: Address; text: string }]>) {
            const text = call.text.replace(/: (started|running)$/, ": interrupted (host restart)");
            await this.send(call.to, `native:${id}`, text);
            this.sent[id] = createHash("sha256").update(text).digest("hex");
          }
        }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        await writeFileDurable(this.file, JSON.stringify({ sent: this.sent, calls: this.calls }));
        this.loaded = true;
      }
      for (const [id, item] of batch) {
        const hash = createHash("sha256").update(item.text).digest("hex");
        if (this.sent[id] !== hash) {
          await this.send(item.to, `native:${id}`, item.text);
          if (item.text.includes("Werkzeug ") && (item.text.endsWith(": started") || item.text.endsWith(": running"))) this.calls[id] = item;
          else delete this.calls[id];
          // Commit the delivered state, not later queued events. A failed durable
          // write must leave the item retryable with the same Matrix transaction.
          const sent = { ...this.sent, [id]: hash };
          // Retain bounded dedup history, independent of model/session persistence.
          while (Object.keys(sent).length > 4096) delete sent[Object.keys(sent)[0]!];
          await writeFileDurable(this.file, JSON.stringify({ sent, calls: this.calls }));
          this.sent = sent;
        }
        if (this.pending.get(id) === item) this.pending.delete(id);
      }
    });
    return this.chain.finally(() => {
      // A transient send failure must not strand the latest pending value.
      if (!this.stopped && this.pending.size && !this.timer) {
        this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch(() => undefined); }, this.delayMs);
        this.timer.unref?.();
      }
    });
  }
}
