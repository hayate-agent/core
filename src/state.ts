/**
 * Persisted runtime state (survives restarts): per-session heartbeat/loop/goal/reply address
 * and agent-wide settings changed via slash commands. Conversation history itself is
 * persisted by the runtime.
 */
import { PartitionedJson } from "./partitioned-json.js";
import type { Goal, OutboxEntry, Recurring } from "./harness.js";
import type { Address, BusyMode, Inbound } from "./types.js";

export interface PersistedSession {
  key: string;
  hashtags?: import("./hashtags.js").HashtagReference[];
  operatorBudgetGrants?: import("./natural-budget-reset.js").OperatorBudgetGrant[];
  task?: import("./harness.js").DurableTask;
  tasks?: import("./harness.js").DurableTask[];
  /** Non-executable historical generated inputs quarantined during recovery upgrade. */
  heldRecoveryInputs?: Inbound[];
  completionRecent?: NonNullable<Inbound["completionContext"]>["recent"];
  /** Last successfully displayed routine status; persisted to deduplicate retries/restarts. */
  statusDelivered?: Record<string, string>;
  replyTo?: Address;
  heartbeat?: Recurring;
  heartbeatDisabled?: boolean;
  stopPending?: boolean;
  resetPending?: boolean;
  resetSources?: string[];
  sourceOwner?: string;
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
  private writing: Promise<void> = Promise.resolve();
  private readonly storage: PartitionedJson;

  constructor(readonly file: string) {
    this.storage = new PartitionedJson(file, {
      sessions: 1, subagents: 1, pending: 1, outbox: 1, seen: 256,
    });
  }

  async load(): Promise<PersistedState | undefined> {
    const data = await this.storage.load() as unknown as PersistedState | undefined;
    if (data && data.version !== 1) throw new Error(`${this.file}: unsupported state version ${String(data.version)}`);
    return data;
  }

  /** Write atomically if content changed. Writes are serialized; a failed write does not block later ones. */
  save(state: PersistedState): Promise<void> {
    const captured = JSON.parse(JSON.stringify(state)) as PersistedState;
    return this.write(() => captured);
  }

  /** Capture live host state only inside the serialized write barrier. Queued
   * callers retain a factory, not another full snapshot/string of every task. */
  capture(snapshot: () => PersistedState): Promise<void> {
    return this.write(snapshot);
  }

  private write(snapshot: () => PersistedState): Promise<void> {
    const run = this.writing.catch(() => undefined).then(async () => {
      await this.storage.save(snapshot() as unknown as Record<string, unknown>);
    });
    this.writing = run;
    return run;
  }
}
