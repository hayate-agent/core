/**
 * Run registry for the Hermes-compatible HTTP API (`/v1/runs`). One run = one turn of an
 * agent session. Run records (status, result, idempotency key) are persisted so a client can
 * poll, reattach and retry across restarts; live events are kept in memory per run.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "../durable.js";
import type { TurnEvent, TurnOutcome } from "../types.js";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["completed", "failed", "cancelled", "interrupted"]);

export interface RunUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export interface RunRecord {
  run_id: string;
  status: RunStatus;
  created_at: number;
  updated_at: number;
  /** Harness session key the turn runs in. */
  session_key: string;
  /** Client-visible session id (body session_id / X-Hermes-Session-Key / run id). */
  session_id: string;
  /** Inbound id of the turn (harness dedup and cancel). */
  input_id: string;
  idempotency_key?: string;
  body_hash?: string;
  /** Requested model ref, if any. */
  model?: string;
  output?: string;
  error?: string;
  usage?: RunUsage;
  cost_usd?: number;
  /** What actually ran (reported, never guessed). */
  actual?: { model?: string; thinking?: string };
  last_event?: string;
  /** Next event sequence number (see RunRegistry.generation). */
  seq: number;
}

export interface RunEvent {
  seq: number;
  data: Record<string, unknown>;
}

type Listener = (event: RunEvent | null) => void;

interface Live {
  events: RunEvent[];
  listeners: Set<Listener>;
}

export interface RunRegistryOptions {
  now?: () => number;
  /** Terminal runs (and their idempotency keys) are kept this long. Default 24h. */
  retentionMs?: number;
  /** Events retained per run for replay. */
  maxEvents?: number;
}

/** Stable hash of a request (idempotency: same key + different payload = conflict). */
export function requestHash(value: unknown): string {
  const canon = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])]))
        : v;
  return createHash("sha256").update(JSON.stringify(canon(value))).digest("hex");
}

export class RunRegistry {
  private readonly runs = new Map<string, RunRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly live = new Map<string, Live>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxEvents: number;
  private writing: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    options: RunRegistryOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? 24 * 3600_000;
    this.maxEvents = options.maxEvents ?? 2000;
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    const data = JSON.parse(raw) as { version: number; generation?: number; runs: RunRecord[] };
    if (data.version !== 1) throw new Error(`${this.file}: unsupported runs version ${String(data.version)}`);
    this.generation = (data.generation ?? 0) + 1;
    const floor = this.generation * RunRegistry.GENERATION_SPAN;
    for (const r of data.runs) {
      if (!TERMINAL.has(r.status)) r.seq = Math.max(r.seq, floor);
      this.index(r);
    }
    this.expire();
    await this.save(); // the new generation is durable before any event id of it is used
  }

  /**
   * Process generation, incremented durably on every load. Event ids of this process start at
   * generation × GENERATION_SPAN, so after a crash a run continues above every id the previous
   * process may have published, even those never saved (Last-Event-ID stays monotonic).
   */
  private generation = 0;
  static readonly GENERATION_SPAN = 2 ** 32;

  /** Durable write of all records (serialized; a failed write does not block later ones). */
  save(): Promise<void> {
    this.expire();
    const records = [...this.runs.values()].map((r) => this.finals.get(r.run_id) ?? r);
    const raw = `${JSON.stringify({ version: 1, generation: this.generation, runs: records })}\n`;
    const run = this.writing.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, raw);
    });
    this.writing = run;
    return run;
  }

  get(runId: string): RunRecord | undefined {
    this.expire();
    return this.runs.get(runId);
  }

  byIdempotencyKey(key: string): RunRecord | undefined {
    this.expire();
    const id = this.byKey.get(key);
    return id ? this.runs.get(id) : undefined;
  }

  /** New queued run (not yet saved: the caller saves before accepting the turn). */
  create(fields: { session_key: string; session_id?: string; idempotency_key?: string; body_hash?: string; model?: string }): RunRecord {
    const run_id = `run_${randomUUID().replace(/-/g, "")}`;
    const at = this.now() / 1000;
    const record: RunRecord = {
      run_id,
      status: "queued",
      created_at: at,
      updated_at: at,
      session_key: fields.session_key,
      session_id: fields.session_id ?? run_id,
      input_id: `api:${run_id}`,
      ...(fields.idempotency_key ? { idempotency_key: fields.idempotency_key, body_hash: fields.body_hash } : {}),
      ...(fields.model ? { model: fields.model } : {}),
      seq: this.generation * RunRegistry.GENERATION_SPAN,
    };
    this.index(record);
    return record;
  }

  /** Drop a run whose turn was never accepted (the client may retry with the same key). */
  remove(runId: string, keepRecord = false): void {
    const r = this.runs.get(runId);
    if (!r) return;
    this.close(runId);
    this.live.delete(runId);
    if (keepRecord) return; // only the live buffer goes: terminal event is rebuilt from the record
    this.runs.delete(runId);
    if (r.idempotency_key && this.byKey.get(r.idempotency_key) === runId) this.byKey.delete(r.idempotency_key);
  }

  /** The turn started (again, after a restart). */
  started(runId: string): void {
    const r = this.runs.get(runId);
    if (!r || TERMINAL.has(r.status) || this.finals.has(runId) || r.status === "running") return;
    this.touch(r, "running");
    this.emit(r, "run.running", { status: "running" });
  }

  /** Live progress of the turn → run events (usage is accumulated per assistant message). */
  turnEvent(runId: string, event: TurnEvent): void {
    const r = this.runs.get(runId);
    if (!r || TERMINAL.has(r.status) || this.finals.has(runId)) return; // frozen while finishing
    if (event.type === "text") this.emit(r, "message.delta", { delta: event.delta });
    else if (event.type === "tool") this.emit(r, event.phase === "start" ? "tool.started" : "tool.completed", { tool: event.name, ...(event.error ? { error: true } : {}) });
    else {
      const u = (r.usage ??= { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
      u.input_tokens += event.input;
      u.output_tokens += event.output;
      u.cache_read_tokens += event.cacheRead;
      u.cache_write_tokens += event.cacheWrite;
      r.cost_usd = (r.cost_usd ?? 0) + event.costUsd;
      r.actual = { model: event.model ?? r.actual?.model, thinking: event.thinking ?? r.actual?.thinking };
      this.emit(r, "usage.updated", { usage: { ...u } });
    }
  }

  /**
   * Record the turn's result durably, then publish the terminal event. Resolves once the
   * result is saved (the harness outbox drops the reply only after that).
   */
  async finish(runId: string, text: string, outcome?: TurnOutcome): Promise<boolean> {
    const r = this.runs.get(runId);
    if (!r) return false;
    if (TERMINAL.has(r.status)) return true; // redelivered result of a finished run
    if (this.finals.has(runId)) return this.finishing.get(runId)!; // concurrent redelivery
    const status: RunStatus = outcome ?? "completed";
    // The terminal event's id (r.seq) is reserved and persisted with the result, so after a
    // restart the terminal event can still be replayed under the same id.
    const final: RunRecord = {
      ...r,
      status,
      updated_at: this.now() / 1000,
      last_event: `run.${status}`,
      seq: r.seq + 1,
    };
    if (status === "failed") final.error = text.replace(/^⚠️\s*/, "") || "run failed";
    else final.output = text;
    // Written with every save from now on, but visible (status, events) only once durable.
    // A failed save throws: the run stays as it was and the outbox redelivers the result.
    // Progress is frozen meanwhile, so the snapshot (and its reserved terminal id) stays exact.
    this.finals.set(runId, final);
    const done = (async () => {
      try {
        await this.save();
      } finally {
        this.finals.delete(runId);
        this.finishing.delete(runId);
      }
      const terminalSeq = final.seq - 1;
      Object.assign(r, final, { seq: terminalSeq });
      this.emit(r, `run.${status}`, this.result(r)); // published as terminalSeq; r.seq = final.seq
      this.close(runId);
      return true;
    })();
    this.finishing.set(runId, done);
    return done;
  }

  private readonly finishing = new Map<string, Promise<boolean>>();

  /** Results being written: serialized in place of the live record until durable. */
  private readonly finals = new Map<string, RunRecord>();

  /** Startup: unfinished runs whose turn is in neither the inbox nor the outbox can never finish. */
  async reconcile(alive: (run: RunRecord) => boolean): Promise<string[]> {
    const lost: string[] = [];
    for (const r of this.runs.values()) {
      if (TERMINAL.has(r.status) || alive(r)) continue;
      this.touch(r, "interrupted");
      r.error = "The agent restarted before this run was accepted.";
      r.last_event = "run.interrupted";
      r.seq++; // reserve the terminal event id (rebuilt from the record on replay)
      // Never accepted (no 202 was sent: that needs the durable inbox entry), so a retry with
      // the same key must start a fresh run instead of replaying this one.
      if (r.idempotency_key && this.byKey.get(r.idempotency_key) === r.run_id) this.byKey.delete(r.idempotency_key);
      delete r.idempotency_key;
      delete r.body_hash;
      lost.push(r.run_id);
    }
    if (lost.length) await this.save();
    for (const id of lost) this.remove(id, true);
    return lost;
  }

  /** Public status object (GET /v1/runs/{id} and terminal event payload). */
  view(r: RunRecord): Record<string, unknown> {
    return {
      object: "hermes.run",
      run_id: r.run_id,
      status: r.status,
      created_at: r.created_at,
      updated_at: r.updated_at,
      session_id: r.session_id,
      ...(r.model ? { model: r.model } : {}),
      ...this.result(r),
      ...(r.last_event ? { last_event: r.last_event } : {}),
    };
  }

  /**
   * Retained events after `lastSeq`, then live ones until the run finishes (listener gets
   * `null`). `truncated`: the oldest retained seq when requested history is gone.
   */
  subscribe(runId: string, lastSeq: number, listener: Listener): { replay: RunEvent[]; truncated?: number; closed: boolean; unsubscribe: () => void } {
    const r = this.runs.get(runId);
    const live = this.live.get(runId);
    if (r && !live && TERMINAL.has(r.status)) {
      // Finished before a restart: no buffer, but the terminal event is rebuilt from the record.
      const seq = r.seq - 1;
      const terminal: RunEvent = { seq, data: { event: `run.${r.status}`, run_id: r.run_id, timestamp: r.updated_at, ...this.result(r) } };
      return { replay: seq > lastSeq ? [terminal] : [], truncated: seq > lastSeq + 1 ? seq : undefined, closed: true, unsubscribe: () => {} };
    }
    const all = live?.events ?? [];
    const replay = all.filter((e) => e.seq > lastSeq);
    const oldest = all[0]?.seq ?? r?.seq ?? 0;
    const truncated = oldest > lastSeq + 1 ? oldest : undefined;
    if (!r || !live || TERMINAL.has(r.status)) return { replay, truncated, closed: true, unsubscribe: () => {} };
    live.listeners.add(listener);
    return { replay, truncated, closed: false, unsubscribe: () => live.listeners.delete(listener) };
  }

  // ------------------------------------------------------------------ internals

  private result(r: RunRecord): Record<string, unknown> {
    const done = r.status === "completed";
    return {
      ...(TERMINAL.has(r.status) ? { completed: done, interrupted: r.status === "cancelled" || r.status === "interrupted" } : {}),
      ...(r.output !== undefined ? { output: r.output } : {}),
      ...(r.error ? { error: r.error } : {}),
      ...(r.usage ? { usage: { ...r.usage, ...(r.actual?.model ? { model: r.actual.model } : {}) } } : {}),
      ...(r.cost_usd !== undefined ? { cost_usd: r.cost_usd } : {}),
      ...(r.actual?.model
        ? {
            execution_routing: {
              applied: true,
              model: r.actual.model,
              provider: r.actual.model.split("/")[0],
              ...(r.actual.thinking ? { reasoning_effort: r.actual.thinking } : {}),
            },
          }
        : {}),
    };
  }

  private index(r: RunRecord): void {
    this.runs.set(r.run_id, r);
    if (r.idempotency_key) this.byKey.set(r.idempotency_key, r.run_id);
    if (!TERMINAL.has(r.status)) this.live.set(r.run_id, { events: [], listeners: new Set() });
  }

  private touch(r: RunRecord, status: RunStatus): void {
    r.status = status;
    r.updated_at = this.now() / 1000;
  }

  private emit(r: RunRecord, name: string, fields: Record<string, unknown>): void {
    const live = this.live.get(r.run_id);
    if (!live) return;
    if (!name.startsWith("message.") && !name.startsWith("usage.")) r.last_event = name;
    const event: RunEvent = { seq: r.seq++, data: { event: name, run_id: r.run_id, timestamp: this.now() / 1000, ...fields } };
    live.events.push(event);
    if (live.events.length > this.maxEvents) live.events.splice(0, live.events.length - this.maxEvents);
    for (const l of [...live.listeners]) l(event);
  }

  /** Terminal: notify subscribers once; the replay buffer stays until the record expires. */
  private close(runId: string): void {
    const live = this.live.get(runId);
    if (!live) return;
    for (const l of [...live.listeners]) l(null);
    live.listeners.clear();
  }

  private expire(): void {
    const cutoff = (this.now() - this.retentionMs) / 1000;
    for (const r of [...this.runs.values()]) {
      if (TERMINAL.has(r.status) && r.updated_at < cutoff) {
        this.remove(r.run_id);
      }
    }
  }
}
