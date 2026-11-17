import { createHash } from "node:crypto";
import type { TurnEvent } from "./types.js";
import { resourceUsageLabel } from "./resource-usage-label.js";
import { executionMetadata, type ExecutionMetadata } from "./builtin-plugins/execution-metadata.js";

/** Host evidence only. No model text, arguments, results or authorization are accepted. */
export interface ActivitySnapshot {
  id: string;
  /** Process-local host generation: orders retries and late events without trusting wall clocks. */
  sequence?: number;
  role: "main" | "worker" | "dispatcher-classifier";
  parent?: string;
  /** Captured by the host from the exact originating assignment, never runtime events. */
  outputTags?: string[];
  context: "operator" | "host" | "scheduled" | "worker";
  phase: "starting" | "running" | "tool" | "completed" | "failed" | "cancelled";
  activity: "opening session" | "selecting model" | "runtime active" | "tool running" | "tool settled" | "turn settled" | "compacting context" | "compaction completed" | "compaction failed; original retained" | "compaction cancelled; original retained" | "model reasoning active" | "preparing tool arguments" | "waiting for local model capacity" | "local model request admitted" | "local model wait cancelled" | "skill reference loaded" | "skill created" | "skill updated" | "working memory recalled";
  tools: Array<{ callId: string; name: string }>;
  execution?: ExecutionMetadata;
  executionState?: "pending" | "observed" | "unavailable";
  elapsedMs: number;
  inactiveMs: number;
}
export interface ActivityPolicy { enabled?: boolean; intervalMs?: number; maxAlive?: number }
export type ActivityEvent = { type: "activity"; kind: "progress" | "alive"; snapshot: ActivitySnapshot; tool?: { callId: string; name: string; state: "started" | "completed" | "failed" }; resource?: { kind: "skill" | "memory"; action: "loaded" | "recalled" | "created" | "updated"; name?: string; locale?: string; label?: string } };

let nextSequence = 0;
const identity = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
// Tool names are runtime metadata, but custom tools can contain arbitrary strings.
const safeName = (name: string) => /^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/.test(name) ? name : "tool";

/** One bounded timer per actual running process turn; never enqueues a prompt. */
export class TurnActivity {
  private readonly sequence = ++nextSequence;
  private readonly started: number;
  private last: number;
  private lastEmitted: number;
  private alive = 0;
  private closed = false;
  private timer?: ReturnType<typeof setInterval>;
  private tools = new Map<string, { callId: string; name: string }>();
  private legacy = 0;
  private execution?: ExecutionMetadata;
  private executionState: "pending" | "observed" | "unavailable" = "pending";
  private phase: ActivitySnapshot["phase"] = "starting";
  private activity: ActivitySnapshot["activity"] = "opening session";
  private readonly interval: number;
  private readonly maxAlive: number;
  private readonly enabled: boolean;
  constructor(private readonly input: { id: string; role: "main" | "worker" | "dispatcher-classifier"; parent?: string; outputTags?: string[]; context: ActivitySnapshot["context"] },
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
    return { ...this.input, outputTags: this.input.outputTags ? [...this.input.outputTags] : undefined, sequence: this.sequence, id: `turn-${identity(this.input.id)}`, parent: this.input.parent ? `context-${identity(this.input.parent)}` : undefined,
      execution: this.execution ? { ...this.execution } : undefined, executionState: this.executionState,
      phase: this.phase, activity: this.activity, tools: [...this.tools.values()].map(tool => ({ ...tool })), elapsedMs: Math.max(0, now - this.started), inactiveMs: Math.max(0, now - this.last) };
  }
  private publish(kind: ActivityEvent["kind"], tool?: ActivityEvent["tool"], resource?: ActivityEvent["resource"]): void {
    if (!this.enabled) return;
    this.lastEmitted = this.now();
    try { this.emit({ type: "activity", kind, snapshot: this.snapshot(), ...(tool ? { tool } : {}), ...(resource ? { resource } : {}) }); } catch { /* Telemetry cannot fail execution. */ }
  }
  running(observationExpected = false): void {
    if (this.closed) return;
    if (observationExpected && this.executionState === "pending") {
      this.phase = "starting"; this.activity = "selecting model";
    } else {
      if (this.executionState === "pending") this.executionState = "unavailable";
      this.phase = "running"; this.activity = "runtime active";
    }
    this.last = this.now(); this.publish("progress");
  }
  event(event: TurnEvent): void {
    if (this.closed) return;
    if (event.type === "model_queue") {
      this.phase = "running";
      this.activity = event.state === "waiting" ? "waiting for local model capacity"
        : event.state === "admitted" ? "local model request admitted" : "local model wait cancelled";
      // Queue notifications do not reset the last own semantic activity time.
      this.publish("progress");
      return;
    }
    // Text/usage indicate real activity, but their content is never exported.
    this.last = this.now();
    if (event.type === "execution") {
      this.execution = executionMetadata(event.selection);
      this.executionState = this.execution.model && this.execution.thinking ? "observed" : "unavailable";
      this.phase = this.tools.size ? "tool" : "running";
      this.activity = this.tools.size ? "tool running" : "runtime active";
      this.publish("progress");
      return;
    }
    if (event.type === "resource_usage") {
      this.phase = "running";
      this.activity = event.resource === "memory" ? "working memory recalled" : event.action === "created" ? "skill created" : event.action === "updated" ? "skill updated" : "skill reference loaded";
      const name = event.name && /^[\p{L}\p{N}_.-]{1,80}$/u.test(event.name) ? event.name : undefined;
      this.publish("progress", undefined, { kind: event.resource, action: event.action, ...(name ? { name } : {}), ...(event.locale ? { locale: event.locale } : {}), label: resourceUsageLabel(event) });
      return;
    }
    if (event.type === "model_progress") {
      const next = event.phase === "reasoning" ? "model reasoning active" : "preparing tool arguments";
      const changed = this.activity !== next;
      this.phase = "running"; this.activity = next;
      if (this.executionState === "pending") this.executionState = "unavailable";
      if (changed || this.now() - this.lastEmitted >= this.interval) this.publish("progress");
      return;
    }
    if (event.type === "compaction") {
      this.phase = "running";
      this.activity = event.state === "started" ? "compacting context" : event.state === "completed" ? "compaction completed"
        : event.state === "failed" ? "compaction failed; original retained" : "compaction cancelled; original retained";
      this.publish("progress");
      return;
    }
    // Productive events without the promised observation must not remain pending forever.
    if (this.executionState === "pending" && (event.type === "tool" || event.type === "text" || event.type === "usage")) {
      this.executionState = "unavailable";
      this.phase = "running"; this.activity = "runtime active";
      this.publish("progress");
    }
    if (event.type !== "tool") return;
    let name = safeName(event.name);
    const key = event.callId ?? (event.phase === "start" ? `legacy-${++this.legacy}` : [...this.tools].find(([, tool]) => tool.name === name)?.[0]);
    if (!key) return;
    if (event.phase === "start") {
      if (this.tools.has(key) || this.tools.size >= 50) return;
      this.tools.set(key, { callId: identity(key), name });
    } else {
      const started = this.tools.get(key);
      if (!started) return;
      name = started.name;
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
    if (this.executionState === "pending") this.executionState = "unavailable";
    this.phase = outcome; this.activity = "turn settled"; this.last = this.now(); this.publish("progress");
  }
}
