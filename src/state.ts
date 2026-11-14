/**
 * Persisted runtime state (survives restarts): per-session heartbeat/loop/goal/reply address
 * and agent-wide settings changed via slash commands. Conversation history itself is
 * persisted by the runtime.
 */
import { mkdir, readFile } from "node:fs/promises";
import { writeFileDurable, writeFileDurableExclusive } from "./durable.js";
import { SessionStateStorage, prepareSessionState, readRegular } from "./session-state-storage.js";
import path from "node:path";
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
  private last = "";
  private writing: Promise<void> = Promise.resolve();

  private readonly shards: SessionStateStorage;
  private legacy?: string;
  constructor(readonly file: string) { this.shards = new SessionStateStorage(`${file}.sessions`); }

  async load(): Promise<PersistedState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    // A read-only observer may race manifest publication/old-revision cleanup.
    // Retry only if the manifest changed; corruption of a stable commit is fatal.
    for (let attempt = 0; ; attempt++) {
      const data = JSON.parse(raw);
      try {
        const state = data.version === 2 ? await this.shards.load(data) : data as PersistedState;
        if (state.version !== 1) throw new Error(`${this.file}: unsupported state version ${String(state.version)}`);
        this.legacy = data.version === 1 ? raw : undefined;
        this.last = data.version === 2 ? raw : "";
        return state;
      } catch (error) {
        if (attempt >= 3) throw error;
        const current = await readFile(this.file, "utf8");
        if (current === raw) throw error;
        raw = current;
      }
    }
  }

  /** Write atomically if content changed. Writes are serialized; a failed write does not block later ones. */
  save(state: PersistedState): Promise<void> {
    // Explicit snapshots may queue behind a commit retiring a formerly-known
    // revision. Keep their bytes until their own staging boundary.
    const prepared = prepareSessionState(state);
    return this.write(() => prepared);
  }

  /** Capture live host state only inside the serialized write barrier. Queued
   * callers retain a factory, not another full snapshot/string of every task. */
  capture(snapshot: () => PersistedState): Promise<void> {
    // Each obligation gets its OWN publication fence. A later snapshot is not
    // assumed to supersede an earlier inbox, stop or uncertain-effect record.
    return this.write(() => prepareSessionState(snapshot(), relative => this.shards.has(relative)));
  }

  private write(snapshot: () => ReturnType<typeof prepareSessionState>): Promise<void> {
    const run = this.writing.catch(() => undefined).then(async () => {
      const prepared = snapshot(), raw = JSON.stringify(prepared.manifest) + "\n";
      if (raw === this.last) return;
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      if (this.legacy !== undefined) {
        try { await writeFileDurableExclusive(`${this.file}.legacy-v1`, this.legacy); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readRegular(`${this.file}.legacy-v1`, true, true) !== this.legacy) throw error;
        }
      }
      await this.shards.stage(prepared);
      // Rename may have succeeded even if its subsequent directory fsync
      // fails. Never let a later return-to-A skip publication using cached A.
      this.last = "";
      await writeFileDurable(this.file, raw);
      this.last = raw; this.legacy = undefined;
      await this.shards.retire(prepared.manifest);
    });
    this.writing = run;
    return run;
  }
}
