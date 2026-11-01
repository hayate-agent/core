import { createHash } from "node:crypto";
import type { TurnEvent } from "./types.js";

/** Host evidence only. No model text, arguments, results or authorization are accepted. */
export interface ActivitySnapshot {
  id: string;
  role: "main" | "worker";
  parent?: string;
  /** Captured by the host from the exact originating assignment, never runtime events. */
  outputTags?: string[];
  context: "operator" | "host" | "scheduled" | "worker";
  phase: "starting" | "running" | "tool" | "completed" | "failed" | "cancelled";
  activity: "opening session" | "runtime active" | "tool running" | "tool settled" | "turn settled";
  tools: Array<{ callId: string; name: string }>;
  elapsedMs: number;
  inactiveMs: number;
}
export interface ActivityPolicy { enabled?: boolean; intervalMs?: number; maxAlive?: number }
export type ActivityEvent = { type: "activity"; kind: "progress" | "alive"; snapshot: ActivitySnapshot; tool?: { callId: string; name: string; state: "started" | "completed" | "failed" } };

const identity = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
// Tool names are runtime metadata, but custom tools can contain arbitrary strings.
const safeName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(name) ? name : "tool";

/** One bounded timer per actual running process turn; never enqueues a prompt. */
export class TurnActivity {
  private readonly started: number;
  private last: number;
  private lastEmitted: number;
  private alive = 0;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private tools = new Map<string, { callId: string; name: string }>();
  private legacy = 0;
  private phase: ActivitySnapshot["phase"] = "starting";
  private activity: ActivitySnapshot["activity"] = "opening session";
  private readonly interval: number;
  private readonly maxAlive: number;
  private readonly enabled: boolean;
  constructor(private readonly input: { id: string; role: "main" | "worker"; parent?: string; outputTags?: string[]; context: ActivitySnapshot["context"] },
    private readonly emit: (event: ActivityEvent) => void, policy: ActivityPolicy = {}, private readonly now = Date.now) {
    this.enabled = policy.enabled !== false;
    this.started = this.last = this.lastEmitted = now();
    this.interval = Number.isFinite(policy.intervalMs) ? Math.max(1000, Math.min(300000, policy.intervalMs!)) : 30000;
    this.maxAlive = Number.isFinite(policy.maxAlive) ? Math.max(0, Math.min(120, Math.floor(policy.maxAlive!))) : 20;
    this.publish("progress");
    if (this.enabled) {
      this.timer = setInterval(() => this.tick(), this.interval);
      this.timer.unref?.();
    }
  }
  snapshot(): ActivitySnapshot {
    const now = this.now();
    return { ...this.input, id: `turn-${identity(this.input.id)}`, parent: this.input.parent ? `context-${identity(this.input.parent)}` : undefined,
      phase: this.phase, activity: this.activity, tools: [...this.tools.values()], elapsedMs: Math.max(0, now - this.started), inactiveMs: Math.max(0, now - this.last) };
  }
  private publish(kind: ActivityEvent["kind"], tool?: ActivityEvent["tool"]): void {
    if (!this.enabled) return;
    this.lastEmitted = this.now();
    try { this.emit({ type: "activity", kind, snapshot: this.snapshot(), ...(tool ? { tool } : {}) }); } catch { /* Telemetry cannot fail execution. */ }
  }
  running(): void {
    if (this.closed) return;
    this.phase = "running"; this.activity = "runtime active"; this.last = this.now(); this.publish("progress");
  }
  event(event: TurnEvent): void {
    if (this.closed) return;
    // Text/usage indicate real activity, but their content is never exported.
    this.last = this.now();
    if (event.type !== "tool") return;
    const name = safeName(event.name);
    const key = event.callId ?? (event.phase === "start" ? `legacy-${++this.legacy}` : [...this.tools].find(([, tool]) => tool.name === name)?.[0]);
    if (!key) return;
    if (event.phase === "start") {
      if (this.tools.has(key) || this.tools.size >= 50) return;
      this.tools.set(key, { callId: identity(key), name });
    } else {
      if (!this.tools.has(key)) return;
      this.tools.delete(key);
    }
    this.phase = this.tools.size ? "tool" : "running";
    this.activity = this.tools.size ? "tool running" : "tool settled";
    this.publish("progress", { callId: identity(key), name, state: event.phase === "start" ? "started" : event.error ? "failed" : "completed" });
  }
  tick(): void {
    if (this.closed || this.alive >= this.maxAlive || this.now() - Math.max(this.last, this.lastEmitted) < this.interval) return;
    this.alive++; this.publish("alive");
  }
  finish(outcome: "completed" | "failed" | "cancelled"): void {
    if (this.closed) return;
    this.closed = true; clearInterval(this.timer); this.tools.clear();
    this.phase = outcome; this.activity = "turn settled"; this.last = this.now(); this.publish("progress");
  }
}
