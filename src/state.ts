/**
 * Persisted runtime state (survives restarts): per-session heartbeat/loop/goal/reply address
 * and agent-wide settings changed via slash commands. Conversation history itself is
 * persisted by the runtime.
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileDurable } from "./durable.js";
import path from "node:path";
import type { Goal, OutboxEntry, Recurring } from "./harness.js";
import type { Address, BusyMode, Inbound } from "./types.js";

export interface PersistedSession {
  key: string;
  hashtags?: import("./hashtags.js").HashtagReference[];
  operatorBudgetGrants?: import("./natural-budget-reset.js").OperatorBudgetGrant[];
  task?: import("./harness.js").DurableTask;
  tasks?: import("./harness.js").DurableTask[];
  completionRecent?: NonNullable<Inbound["completionContext"]>["recent"];
  /** Last successfully displayed routine status; persisted to deduplicate retries/restarts. */
  statusDelivered?: Record<string, string>;
  replyTo?: Address;
  heartbeat?: Recurring;
  heartbeatDisabled?: boolean;
  stopPending?: boolean;
  loop?: Recurring;
  goal?: Goal;
}

export interface PersistedState {
  version: 1;
  paused: boolean;
  busyMode: BusyMode;
  home?: Address;
  approvals?: { mode: "off" | "manual"; tools: string[] };
  personality?: string;
  /** /cron pause|resume overrides of jobs.yaml `enabled` (name → enabled). */
  cronOverrides?: Record<string, boolean>;
  sessions: PersistedSession[];
  subagents?: import("./subagents.js").SubagentRecord[];
  subagentOverrides?: Record<string,{model:string;thinking:string}>;
  /** Unfinished inputs (inbox); replayed on start. */
  pending?: Inbound[];
  /** Replies of finished turns not yet delivered; sent on start, turns are not re-run. */
  outbox?: OutboxEntry[];
  /** Ids of accepted channel inputs (dedupe on redelivery). */
  seen?: string[];
}

export class StateStore {
  private last = "";
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly file: string) {}

  async load(): Promise<PersistedState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    const data = JSON.parse(raw) as PersistedState;
    if (data.version !== 1) throw new Error(`${this.file}: unsupported state version ${String(data.version)}`);
    this.last = raw;
    return data;
  }

  /** Write atomically if content changed. Writes are serialized; a failed write does not block later ones. */
  save(state: PersistedState): Promise<void> {
    const raw = `${JSON.stringify(state, null, 2)}\n`;
    const run = this.writing.catch(() => undefined).then(async () => {
      if (raw === this.last) return;
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, raw);
      this.last = raw;
    });
    this.writing = run;
    return run;
  }
}
