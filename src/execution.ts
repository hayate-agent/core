import { executionMetadata, type ExecutionMetadata } from "./builtin-plugins/execution-metadata.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import { recoveryBlock, type RecoveryStrategy, type ExecutionRecoveryPolicy } from "./execution-recovery.js";

/** Expected contention with a control or another claimant, not a storage failure. */
export class ExecutionClaimConflict extends Error {}

/** Closed host-owned causes; exception/worker text is never persisted here. */
export type ExecutionDiagnosticCode = "runtime-failure" | "worker-failed" | "worker-cancelled" | "manual-pause";
export class ExecutionWorkerFailure extends Error {
  constructor(readonly diagnosticCode: "worker-failed" | "worker-cancelled") { super(diagnosticCode); }
}

export type ExecutionStatus = "ready" | "running" | "paused" | "blocked" | "completed" | "cancelled";
export interface Execution {
  id: string;
  /** Host-captured parent mandate; never accepted from model tool arguments. */
  dependency?: { taskId: string; depth: number; original: string; expiresAt?: number; anchor?: import("./types.js").Inbound["completionAnchor"] };
  requestId: string;
  parent: string;
  input: string;
  strategy: string;
  strategyVersion: number;
  status: ExecutionStatus;
  execution?: ExecutionMetadata;
  classifier?: { requested: ExecutionMetadata; actual?: ExecutionMetadata };
  /** Retained across claims. Unknown sends require explicit reconciliation, never replay. */
  classifierReceipt?: import("./classifier-http.js").ClassifierReceipt & { token: string };
  checkpoint?: string;
  result?: string;
  token?: string;
  restarts: number;
  recoveryReason?: string;
  diagnosticCode?: ExecutionDiagnosticCode;
  /** Prior token-scoped transcript, never an ownership credential. */
  recoverySession?: string;
  resolutions?: Array<{ actor: string; action: "continue" | "retry"; evidence: string; at: number }>;
  /** Consumed atomically by the next claim; history is not authorization. */
  recoveryGrant?: { action: "continue" | "retry"; restarts: number };
  /** Returned by claim only, never persisted as permission for another attempt. */
  claimedRecoveryAction?: "continue" | "retry";
  terminalAt?: number;
  question?: { id: string; text: string; answer?: string };
  /** Parent stop permanently revokes result delivery as well as execution. */
  parentStopped?: boolean;
  intent?: { key: string; replay: "safe" | "unsafe"; result?: string; route?: import("./model-roles.js").ModelPair };
  /** Last committed effect outcome, retained across the completion commit gap. */
  settledEffect?: { key: string; result: string };
}
export interface ExecutionEvent {
  id: string;
  executionId: string;
  parent: string;
  type: "accepted" | "status" | "question" | "result";
  text: string;
  /** State at event creation, not the potentially newer state at delivery. */
  status?: ExecutionStatus;
}
export interface TurnSettlement {
  repetition?: import("./repetition-budget.js").RepetitionBudget;
  cronOutput?: string;
  outbox: import("./delivery/outbox.js").OutboxEntry[];
  continuation?: import("./types.js").Inbound["continuation"];
  goal?: import("./harness.js").Goal;
  consumed: string[];
}
export interface DurableTurn { id: string; sessionKey: string; state: "running" | "settled"; stopped?: boolean; settlement?: TurnSettlement }
export type WaitAuthorityDenialReason = "ownership" | "cancelled" | "deadline" | "missing-task" | "stopped-task" | "sequence";
export interface WaitAuthorityDenialReceipt {
  reason: WaitAuthorityDenialReason;
  taskId?: string;
  waitSequence: number;
  taskWaitSequence?: number;
  turnId?: string;
  at: number;
}
const waitDenialReasons = ["ownership", "cancelled", "deadline", "missing-task", "stopped-task", "sequence"] as const;
interface Ledger { version: 1; executions: Execution[]; events: ExecutionEvent[]; turns?: DurableTurn[];
  waitAuthorityDenials?: WaitAuthorityDenialReceipt[] }

/** One host owns this ledger under the Harness home lock. Mutations become visible
 * only after atomic durable replacement; task transitions and outgoing events share
 * the same commit. No timers, model calls, or plugin code run inside transactions. */
export class ExecutionStore {
  private data: Ledger = { version: 1, executions: [], events: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  constructor(private readonly file: string, private readonly retention: {
    now?: () => number;
    protectedExecutions?: () => ReadonlySet<string>;
  } = {}) {}
  private now(): number { return this.retention.now?.() ?? Date.now(); }
  private archiveFile(parent: string, requestId: string): string {
    const key = createHash("sha256").update(JSON.stringify([parent, requestId])).digest("hex");
    return path.join(`${this.file}.archive`, `${key}.json`);
  }
  private async archived(parent: string, requestId: string): Promise<Execution | undefined> {
    try {
      const task = JSON.parse(await readFile(this.archiveFile(parent, requestId), "utf8")) as Execution;
      if (task.parent !== parent || task.requestId !== requestId || !["completed", "cancelled"].includes(task.status)) throw Error("Invalid execution archive");
      return task;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(): Promise<void> {
    if (this.loaded) throw Error("Execution store already loaded");
    try {
      if ((await stat(this.file)).size > 32 * 1024 * 1024) throw Error("Execution ledger size limit exceeded");
      const data = JSON.parse(await readFile(this.file, "utf8")) as Ledger;
      if (data.version !== 1 || !Array.isArray(data.executions) || !Array.isArray(data.events)) throw Error("Unsupported execution ledger");
      if (data.waitAuthorityDenials !== undefined && (!Array.isArray(data.waitAuthorityDenials) ||
          data.waitAuthorityDenials.length > 100 || data.waitAuthorityDenials.some(r =>
            !r || !waitDenialReasons.includes(r.reason) || !Number.isSafeInteger(r.at) ||
            !Number.isSafeInteger(r.waitSequence) || (r.taskWaitSequence !== undefined && !Number.isSafeInteger(r.taskWaitSequence)) ||
            [r.taskId, r.turnId].some(id => id !== undefined && (typeof id !== "string" || id.length > 128)) ||
            Object.keys(r).some(key => !["reason", "taskId", "waitSequence", "taskWaitSequence", "turnId", "at"].includes(key)))))
        throw Error("Invalid wait authority denial receipt");
      const ids = new Set<string>();
      for (const item of data.executions) {
        if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.parent !== "string" ||
            typeof item.requestId !== "string" || typeof item.input !== "string" || typeof item.strategy !== "string" ||
            !Number.isSafeInteger(item.strategyVersion) || item.strategyVersion < 1 ||
            !["ready", "running", "paused", "blocked", "completed", "cancelled"].includes(item.status) ||
            !Number.isSafeInteger(item.restarts) || item.restarts < 0) throw Error("Invalid execution record");
        if (item.question !== undefined && (!item.question || typeof item.question.id !== "string" || !item.question.id ||
            typeof item.question.text !== "string" || !item.question.text.trim() || item.question.text.length > 8000 ||
            (item.question.answer !== undefined && (typeof item.question.answer !== "string" || item.question.answer.length > 8000)))) throw Error("Invalid execution question");
        if (item.terminalAt !== undefined && (!Number.isSafeInteger(item.terminalAt) || item.terminalAt < 0)) throw Error("Invalid terminal timestamp");
        if (item.parentStopped !== undefined && typeof item.parentStopped !== "boolean") throw Error("Invalid parent stop marker");
        for (const value of [item.checkpoint, item.result, item.token]) {
          if (value !== undefined && (typeof value !== "string" || value.length > 64000)) throw Error("Invalid execution field");
        }
        if (item.intent !== undefined && (!item.intent || typeof item.intent.key !== "string" || !item.intent.key.trim() ||
            !["safe", "unsafe"].includes(item.intent.replay))) throw Error("Invalid execution intent");
        if (item.settledEffect !== undefined && (!item.settledEffect || typeof item.settledEffect.key !== "string" || !item.settledEffect.key.trim() ||
            typeof item.settledEffect.result !== "string" || item.settledEffect.result.length > 64000)) throw Error("Invalid settled effect");
        if (item.classifierReceipt !== undefined) {
          const receipt = item.classifierReceipt;
          if (!receipt || !["initial", "fallback", "observed"].includes(receipt.phase) ||
              typeof receipt.token !== "string" || !receipt.token || !receipt.actual ||
              typeof receipt.actual.model !== "string" || typeof receipt.actual.thinking !== "string" ||
              (receipt.complexity !== undefined && (receipt.phase !== "observed" ||
                !["simple", "medium", "high"].includes(receipt.complexity)))) throw Error("Invalid classifier receipt");
        }
        if (item.claimedRecoveryAction !== undefined) throw Error("Invalid persisted claim-only recovery action");
        if (item.recoveryGrant !== undefined && (!item.recoveryGrant ||
            !["continue", "retry"].includes(item.recoveryGrant.action) ||
            !Number.isSafeInteger(item.recoveryGrant.restarts) || item.recoveryGrant.restarts < 0)) throw Error("Invalid recovery grant");
        ids.add(item.id);
      }
      const eventIds = new Set<string>();
      for (const event of data.events) {
        if (!event || typeof event.id !== "string" || !event.id || eventIds.has(event.id) || !ids.has(event.executionId) ||
            data.executions.find(item => item.id === event.executionId)?.parent !== event.parent || typeof event.parent !== "string" ||
            !["accepted", "status", "question", "result"].includes(event.type) || typeof event.text !== "string") throw Error("Invalid execution event");
        eventIds.add(event.id);
      }
      if (data.turns !== undefined) {
        if (!Array.isArray(data.turns)) throw Error("Invalid durable turns");
        const turnIds = new Set<string>();
        for (const turn of data.turns) {
          if (!turn || typeof turn.id !== "string" || !turn.id || turnIds.has(turn.id) ||
              typeof turn.sessionKey !== "string" || !turn.sessionKey || !["running", "settled"].includes(turn.state)) throw Error("Invalid durable turn");
          if (turn.stopped !== undefined && typeof turn.stopped !== "boolean") throw Error("Invalid turn stop marker");
          turnIds.add(turn.id);
          if (turn.state === "settled") this.validateSettlement(turn.sessionKey, turn.settlement);
          else if (turn.settlement !== undefined) throw Error("Unexpected turn settlement");
        }
      }
      this.data = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private mutate<T>(fn: (draft: Ledger) => T | Promise<T>): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      if (!this.loaded) throw Error("Execution store not loaded");
      const draft = structuredClone(this.data);
      const result = await fn(draft);
      await mkdir(path.dirname(this.file), { recursive: true });
      const serialized = `${JSON.stringify(draft)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > 32 * 1024 * 1024) throw Error("Execution ledger size limit reached; reconcile retained records");
      await writeFileDurable(this.file, serialized);
      this.data = draft;
      return structuredClone(result);
    });
    this.queue = next;
    return next;
  }
  private event(draft: Ledger, task: Execution, type: ExecutionEvent["type"], text: string): void {
    draft.events.push({ id: randomUUID(), executionId: task.id, parent: task.parent, type, text, status: task.status });
  }
  private find(draft: Ledger, id: string): Execution {
    const task = draft.executions.find(item => item.id === id);
    if (!task) throw Error("Unknown execution");
    return task;
  }
  private owned(draft: Ledger, id: string, token: string): Execution {
    const task = this.find(draft, id);
    if (task.status !== "running" || task.token !== token) throw Error("Stale execution claim");
    return task;
  }
  private validateSettlement(sessionKey: string, value: unknown): asserts value is TurnSettlement {
    const settlement = value as TurnSettlement | undefined;
    if (!settlement || !Array.isArray(settlement.outbox) || !Array.isArray(settlement.consumed) ||
        settlement.consumed.some(id => typeof id !== "string" || !id) ||
        settlement.outbox.some(entry => !entry || entry.sessionKey !== sessionKey || typeof entry.id !== "string" ||
          typeof entry.text !== "string" || !entry.to || typeof entry.to.channel !== "string" || typeof entry.to.target !== "string" ||
          (entry.outcome !== undefined && !["completed", "failed", "cancelled"].includes(entry.outcome)))) throw Error("Invalid turn settlement");
    const plan = settlement.continuation;
    if (plan !== undefined && (!plan || !["continue", "waiting", "blocked", "completed"].includes(plan.state) ||
        (plan.state === "continue" && (typeof plan.next !== "string" || !plan.next.trim() || plan.next.length > 4000)) ||
        (plan.expiresAt !== undefined && !Number.isSafeInteger(plan.expiresAt)))) throw Error("Invalid settled continuation");
    const goal = settlement.goal;
    if (goal !== undefined && (!goal || typeof goal.text !== "string" || !Array.isArray(goal.criteria) ||
        goal.criteria.some(item => typeof item !== "string") || typeof goal.paused !== "boolean" ||
        !Number.isSafeInteger(goal.turns) || goal.turns < 0)) throw Error("Invalid settled goal");
  }
  turn(id: string, sessionKey: string): DurableTurn | undefined {
    const turn = this.data.turns?.find(item => item.id === id);
    if (turn && turn.sessionKey !== sessionKey) throw Error("Turn identity conflict");
    return turn ? structuredClone(turn) : undefined;
  }
  /** Called only after the inbox/outbox completion snapshot is durable. An
   * unresolved dispatcher intent still needs its worker settlement on restart. */
  acknowledgeTurn(id: string, sessionKey: string): Promise<void> {
    return this.mutate(draft => {
      const turn = draft.turns?.find(item => item.id === id && item.sessionKey === sessionKey);
      if (!turn || turn.state !== "settled") return;
      if (draft.executions.some(task => task.token && task.intent &&
          sessionKey === `dispatch:${task.id}:${task.token}`)) return;
      const consumed = new Set([id, ...(turn.settlement?.consumed ?? [])]);
      draft.turns = draft.turns?.filter(item => item.sessionKey !== sessionKey || !consumed.has(item.id));
    });
  }
  /** Startup-only: the persisted inbox is authoritative before any pumps run.
   * Reclaims a crash after completion save but before acknowledgeTurn. */
  reconcileSettledTurns(pendingIds: ReadonlySet<string>): Promise<void> {
    return this.mutate(draft => {
      draft.turns = draft.turns?.filter(turn => pendingIds.has(turn.id) ||
        draft.executions.some(task => task.token && task.intent && turn.sessionKey === `dispatch:${task.id}:${task.token}`));
    });
  }
  beginTurn(id: string, sessionKey: string): Promise<void> {
    return this.mutate(draft => {
      if (typeof id !== "string" || !id || typeof sessionKey !== "string" || !sessionKey) throw Error("Invalid turn identity");
      const turns = draft.turns ??= [];
      const old = turns.find(item => item.id === id);
      if (old && old.sessionKey !== sessionKey) throw Error("Turn identity conflict");
      if (!old) {
        if (turns.length >= 10000) throw Error("Retained turn limit reached; reconcile before executing more work");
        turns.push({ id, sessionKey, state: "running" });
      }
    });
  }
  private stoppedSettlement(settlement: TurnSettlement): TurnSettlement {
    return { ...settlement, continuation: undefined, outbox: settlement.outbox.map(entry => ({
      ...entry, text: "⏹️ Abgebrochen. Bereits ausgeführte Seiteneffekte prüfen.", outcome: "cancelled",
    })) };
  }
  stopTurn(id: string, sessionKey: string): Promise<void> {
    return this.mutate(draft => {
      const turn = draft.turns?.find(item => item.id === id);
      if (turn && turn.sessionKey !== sessionKey) throw Error("Turn identity conflict");
      if (!turn) {
        if (!id || !sessionKey) throw Error("Invalid turn identity");
        (draft.turns ??= []).push({ id, sessionKey, state: "running", stopped: true });
        return;
      }
      turn.stopped = true;
      if (turn.settlement) turn.settlement = this.stoppedSettlement(turn.settlement);
    });
  }
  settleTurn(id: string, sessionKey: string, settlement: TurnSettlement): Promise<void> {
    return this.mutate(draft => {
      const turn = draft.turns?.find(item => item.id === id && item.sessionKey === sessionKey);
      if (!turn) throw Error("Unknown durable turn");
      this.validateSettlement(sessionKey, settlement);
      if (turn.state === "settled") throw Error("Turn already settled");
      turn.state = "settled";
      turn.settlement = structuredClone(turn.stopped ? this.stoppedSettlement(settlement) : settlement);
    });
  }
  /** Conversation-scoped durable lookup, including compacted terminal records. */
  async findRequest(parent: string, requestId: string): Promise<Execution | undefined> {
    const task = this.data.executions.find(item => item.parent === parent && item.requestId === requestId)
      ?? await this.archived(parent, requestId);
    return task ? structuredClone(task) : undefined;
  }
  list(parent?: string): Execution[] {
    return structuredClone(this.data.executions.filter(item => parent === undefined || item.parent === parent));
  }
  events(): ExecutionEvent[] { return structuredClone(this.data.events); }

  waitAuthorityDenials(): WaitAuthorityDenialReceipt[] { return structuredClone(this.data.waitAuthorityDenials ?? []); }

  /** Host-only diagnostic ring; never an outgoing event or authority input. */
  recordWaitAuthorityDenial(receipt: WaitAuthorityDenialReceipt): Promise<void> {
    // Explicit projection prevents extra properties (arguments, text, errors) entering the ledger.
    const safe: WaitAuthorityDenialReceipt = {
      reason: receipt.reason, at: receipt.at, waitSequence: receipt.waitSequence,
      taskWaitSequence: receipt.taskWaitSequence,
      taskId: receipt.taskId?.slice(0, 128), turnId: receipt.turnId?.slice(0, 128),
    };
    return this.mutate(draft => {
      draft.waitAuthorityDenials = [...(draft.waitAuthorityDenials ?? []), safe].slice(-100);
    });
  }
  submit(parent: string, requestId: string, input: string, strategy: string, strategyVersion = 1, dependency?: Execution["dependency"]): Promise<Execution> {
    return this.mutate(async draft => {
      if (![parent, requestId, input, strategy].every(value => typeof value === "string" && value.trim()) || input.length > 1024 * 1024 ||
          !Number.isSafeInteger(strategyVersion) || strategyVersion < 1) throw Error("Invalid execution submission");
      const old = draft.executions.find(item => item.parent === parent && item.requestId === requestId) ?? await this.archived(parent, requestId);
      if (old) {
        if (old.input !== input || old.strategy !== strategy || old.strategyVersion !== strategyVersion) throw Error("Conflicting execution request ID");
        return old;
      }
      if (draft.executions.length >= 2000) throw Error("Retained execution limit reached; archive only after reconciliation");
      const task: Execution = { dependency: structuredClone(dependency), id: randomUUID(), parent, requestId, input, strategy, strategyVersion, status: "ready", restarts: 0 };
      draft.executions.push(task);
      this.event(draft, task, "accepted", "Auftrag angenommen");
      return task;
    });
  }
  /** Current policy is supplied by the trusted host registry, never by model input.
   * Recovery is not itself a replay grant: policy is checked again at claim time. */
  claim(id: string, current?: RecoveryStrategy & { strategy: string }, policy?: ExecutionRecoveryPolicy): Promise<Execution> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.status !== "ready") throw new ExecutionClaimConflict("Execution not ready");
      const reason = task.intent ? recoveryBlock(task, current?.strategy === task.strategy ? current : undefined, policy) : undefined;
      if (reason) throw Error(reason);
      const claimedRecoveryAction = task.recoveryGrant?.restarts === task.restarts ? task.recoveryGrant.action : undefined;
      delete task.recoveryGrant;
      delete task.execution; // A new attempt has no observed selection yet.
      delete task.classifier;
      task.token = randomUUID();
      task.status = "running";
      this.event(draft, task, "status", "Ausführung gestartet");
      return { ...task, claimedRecoveryAction };
    });
  }
  /** Roll back only a scheduler claim that never reached its strategy. */
  releaseUnstartedClaim(id: string, token: string, recoveryAction?: "continue" | "retry"): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      task.status = "ready";
      if (recoveryAction) task.recoveryGrant = { action: recoveryAction, restarts: task.restarts };
      delete task.token;
    });
  }
  observeExecution(id: string, token: string, selection: ExecutionMetadata): Promise<void> {
    return this.mutate(draft => { this.owned(draft, id, token).execution = executionMetadata(selection); });
  }
  observeClassifier(id: string, token: string, requested: ExecutionMetadata, actual?: ExecutionMetadata): Promise<void> {
    return this.mutate(draft => { this.owned(draft, id, token).classifier = {
      requested: executionMetadata(requested), ...(actual ? { actual: executionMetadata(actual) } : {}),
    }; });
  }
  classifierAssessment(id: string, token: string, receipt: import("./classifier-http.js").ClassifierReceipt): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      const previous = task.classifierReceipt;
      if (receipt.phase === "initial" ? !!previous : !previous || previous.token !== token ||
          previous.phase === "observed" || (receipt.phase === "fallback" && previous.phase !== "initial")) {
        throw Error("Classifier receipt cannot be replayed");
      }
      task.classifierReceipt = { ...receipt, token };
    });
  }
  checkpoint(id: string, token: string, checkpoint: string): Promise<void> {
    return this.mutate(draft => {
      if (typeof checkpoint !== "string" || checkpoint.length > 64000) throw Error("Invalid checkpoint");
      const task = this.owned(draft, id, token);
      task.checkpoint = checkpoint;
      task.restarts = 0;
    });
  }
  workerSession(id: string, token: string, key: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      if (key !== `dispatch:${id}:${token}`) throw Error("Invalid worker session");
      task.recoverySession = key;
    });
  }
  intent(id: string, token: string, key: string, replay: "safe" | "unsafe", route?: import("./model-roles.js").ModelPair): Promise<void> {
    if (route !== undefined && (!route || typeof route !== "object" || Array.isArray(route) || Object.keys(route).some(k => !["model", "thinking"].includes(k)) ||
        (route.model !== undefined && (typeof route.model !== "string" || route.model.length > 200)) ||
        (route.thinking !== undefined && (typeof route.thinking !== "string" || route.thinking.length > 40)))) throw Error("Invalid selected route");
    return this.mutate(draft => {
      if (typeof key !== "string" || !key.trim() || !["safe", "unsafe"].includes(replay)) throw Error("Invalid effect intent");
      const task = this.owned(draft, id, token);
      if (task.intent) throw Error("Resolve previous effect intent first");
      task.intent = { key, replay, ...(route ? { route: structuredClone(route) } : {}) };
    });
  }
  settleIntent(id: string, token: string, key: string, result: string, checkpoint: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      if (task.intent?.key !== key) throw Error("Unknown effect intent");
      if (typeof result !== "string" || typeof checkpoint !== "string" || result.length > 64000 || checkpoint.length > 64000) throw Error("Invalid effect result");
      task.checkpoint = checkpoint;
      task.settledEffect = { key, result };
      // The bridge now owns the durable result; the common worker settlement
      // is redundant even if its Harness completion acknowledgement raced us.
      draft.turns = draft.turns?.filter(turn => turn.sessionKey !== `dispatch:${id}:${token}`);
      // Preserve the outcome independently of the strategy's next checkpoint.
      delete task.intent;
      task.restarts = 0;
    });
  }
  report(id: string, token: string, text: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      if (typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid status message");
      if (draft.events.filter(event => event.executionId === id).length >= 100) throw Error("Pending event limit reached");
      this.event(draft, task, "status", text);
    });
  }
  ask(id: string, token: string, text: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      if (task.intent) throw Error("Cannot ask with unresolved effect intent");
      if (typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid question");
      task.question = { id: randomUUID(), text };
      task.status = "paused";
      delete task.token;
      this.event(draft, task, "question", `Question ${task.question.id}: ${text}`);
    });
  }
  answer(parent: string, id: string, questionId: string, text: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.parent !== parent || task.parentStopped || task.intent || task.status !== "paused" ||
          task.question?.id !== questionId || task.question.answer !== undefined) throw Error("Question no longer awaiting an answer");
      if (typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid answer");
      task.question.answer = text;
      task.status = "ready";
      this.event(draft, task, "status", "Antwort gespeichert; Ausführung bereit");
    });
  }
  complete(id: string, token: string, result: string): Promise<void> {
    return this.mutate(draft => {
      if (typeof result !== "string" || result.length > 64000) throw Error("Invalid execution result");
      const task = this.owned(draft, id, token);
      if (task.intent) throw Error("Unresolved effect intent");
      task.status = "completed";
      task.terminalAt = this.now();
      task.result = result;
      delete task.token;
      this.event(draft, task, "result", result);
    });
  }
  cancelParent(parent: string): Promise<void> {
    return this.mutate(draft => {
      for (const task of draft.executions) {
        if (task.parent !== parent) continue;
        task.parentStopped = true;
        if (!["completed", "cancelled"].includes(task.status)) task.status = "cancelled";
        task.terminalAt ??= this.now();
        delete task.token;
      }
      draft.events = draft.events.filter(event => event.parent !== parent);
    });
  }
  /** Token fencing prevents a late failure from pausing a replacement claim. */
  fail(id: string, token: string, code: ExecutionDiagnosticCode): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.status !== "running" || task.token !== token) return;
      task.status = task.intent ? "blocked" : "paused";
      task.diagnosticCode = code;
      delete task.token;
      this.event(draft, task, "status", task.status);
    });
  }
  control(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (["completed", "cancelled"].includes(task.status)) return;
      if (action === "resume") {
        if (task.status !== "paused" || task.intent || (task.question && task.question.answer === undefined)) throw Error("Execution cannot resume without resolving its blocker");
        task.status = "ready";
        delete task.diagnosticCode;
      } else if (action === "pause") {
        // Pause is not a blocker-resolution API. Revoking an in-flight effect
        // leaves its outcome ambiguous, even before startup recovery runs.
        if (task.status === "blocked") return;
        task.status = task.intent ? "blocked" : "paused";
        task.diagnosticCode = "manual-pause";
      } else { task.status = "cancelled"; task.terminalAt = this.now(); }
      // Revoke the old worker before any replacement can claim the task.
      delete task.token;
      this.event(draft, task, "status", task.status);
    });
  }
  /** Startup reconstruction is separate from scheduling. Unknown strategies/versions
   * and ambiguous external effects stay blocked. Both old and new replay policy must agree. */
  recover(strategies: ReadonlyMap<string, RecoveryStrategy>, restartLimit?: number, policy?: ExecutionRecoveryPolicy, enabled: (task: Execution) => boolean = () => true): Promise<void> {
    if (restartLimit !== undefined && (!Number.isSafeInteger(restartLimit) || restartLimit < 0)) throw Error("Invalid recovery restart limit");
    return this.mutate(draft => {
      for (const task of draft.executions) {
        if (!enabled(task) || !["ready", "running"].includes(task.status)) continue;
        const strategy = strategies.get(task.strategy);
        const interrupted = task.status === "running";
        if (interrupted) task.restarts++;
        // A direct worker may have durably settled before its internal outbox
        // reached the bridge. Adopt only its exact token-bound successful reply.
        if (interrupted && task.strategy === "direct" && task.strategyVersion === 1 && task.token &&
            task.intent?.key === `turn:${task.id}:${task.token}` && !task.parentStopped) {
          const key = `${task.id}:${task.token}`;
          const replies = draft.turns?.filter(turn => turn.sessionKey === `dispatch:${key}` && turn.state === "settled")
            .flatMap(turn => turn.settlement?.outbox ?? [])
            .filter(entry => entry.to.channel === "dispatch" && entry.to.target === key);
          if (replies?.length === 1 && !replies[0]!.outcome) {
            const result = replies[0]!.text.slice(0, 64000);
            task.settledEffect = { key: task.intent.key, result };
            task.checkpoint = result;
            draft.turns = draft.turns?.filter(turn => turn.sessionKey !== `dispatch:${key}`);
            delete task.intent;
            task.restarts = 0;
          }
        }
        if (!task.recoverySession && task.token && task.intent) task.recoverySession = `dispatch:${task.id}:${task.token}`;
        delete task.token;
        const reason = restartLimit !== undefined && task.restarts >= restartLimit
          ? `Recovery restart limit ${restartLimit} reached; inspect evidence and resolve before retrying.`
          : task.classifierReceipt && task.classifierReceipt.phase !== "observed"
            ? "Classifier HTTP outcome unknown; retained receipt forbids automatic replay."
            : recoveryBlock(task, strategy, policy);
        if (reason) {
          task.recoveryReason = reason;
          task.status = "blocked";
          this.event(draft, task, "status", reason);
        } else { task.status = "ready"; delete task.recoveryReason; }
      }
      // Dispatcher inboxes never replay independently; after claim recovery
      // their orphan turn records carry no additional execution authority.
      draft.turns = draft.turns?.filter(turn => !turn.sessionKey.startsWith("dispatch:") ||
        draft.executions.some(task => task.token && task.intent && turn.sessionKey === `dispatch:${task.id}:${task.token}`));
    });
  }
  /** Explicit acknowledgement retains ambiguous intent and audit history. No budget reset. */
  resolve(parent: string, id: string, actor: string, action: "continue" | "retry", evidence: string): Promise<void> {
    if (!actor.trim() || !evidence.trim() || evidence.length > 8000) return Promise.reject(Error("Actor and bounded evidence required"));
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.parent !== parent || task.parentStopped || !["blocked", "paused"].includes(task.status) || (task.question && task.question.answer === undefined)) throw Error("Execution cannot be resolved");
      if (!task.recoverySession && task.token && task.intent) task.recoverySession = `dispatch:${task.id}:${task.token}`;
      delete task.token;
      (task.resolutions ??= []).push({ actor, action, evidence, at: this.now() });
      task.recoveryGrant = { action, restarts: task.restarts };
      delete task.recoveryReason;
      task.status = "ready";
      this.event(draft, task, "status", `${actor}: ${action}; uncertain effects may duplicate. Evidence: ${evidence}`);
    });
  }
  /** Archive before removing active records. A crash between commits leaves an
   * idempotent duplicate, never a missing request-ID receipt. Archives are not
   * automatically deleted: deleting them would permit duplicate side effects. */
  compact(parent?: string, minimumAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    return this.mutate(async draft => {
      if (!Number.isSafeInteger(minimumAgeMs) || minimumAgeMs < 0) throw Error("Invalid retention age");
      // Legacy records receive a fresh retention window, never immediate expiry.
      for (const task of draft.executions) if (["completed", "cancelled"].includes(task.status)) task.terminalAt ??= this.now();
      const protectedIds = this.retention.protectedExecutions?.() ?? new Set<string>();
      const eligible = draft.executions.filter(task => (parent === undefined || task.parent === parent) &&
        ["completed", "cancelled"].includes(task.status) && !task.intent && !task.token && !protectedIds.has(task.id) &&
        !draft.events.some(event => event.executionId === task.id) &&
        task.terminalAt !== undefined && this.now() - task.terminalAt >= minimumAgeMs);
      if (!eligible.length) return 0;
      await mkdir(`${this.file}.archive`, { recursive: true });
      for (const task of eligible) await writeFileDurable(this.archiveFile(task.parent, task.requestId), `${JSON.stringify(task)}\n`);
      // Check again after asynchronous archive writes: a host acceptance may
      // have become pending while we awaited filesystem I/O.
      const latestProtected = this.retention.protectedExecutions?.() ?? new Set<string>();
      const ids = new Set(eligible.filter(task => !latestProtected.has(task.id)).map(task => task.id));
      draft.executions = draft.executions.filter(task => !ids.has(task.id));
      return ids.size;
    });
  }
  ack(eventId: string): Promise<void> {
    return this.mutate(draft => { draft.events = draft.events.filter(event => event.id !== eventId); });
  }
}
