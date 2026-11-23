import { enrollTask, operatorTransition, commitTaskOutcome, expireInactiveTasks, validateTaskBook, taskOpen, type TaskBook, type TaskRef, type TaskOutcome, type CoreTask, type TaskReceipt, taskDigest, renderTask } from "./task-lifecycle.js";
import { validCronCheckpoint } from "./cron-checkpoint.js";
import { executionMetadata, type ExecutionMetadata } from "./builtin-plugins/execution-metadata.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable, writeFileDurableExclusive, syncDirStrict } from "./durable.js";
import { PartitionedJson } from "./partitioned-json.js";
import { ExecutionDependencyStorage, freezeExecutionDependency } from "./execution-dependency-storage.js";
import { TaskBookStorage } from "./task-book-storage.js";
import { recoveryBlock, type RecoveryStrategy, type ExecutionRecoveryPolicy } from "./execution-recovery.js";
import { message, resolveLanguage } from "./language.js";

/** Exact host state fence for evidence-backed parent continuation. */
export function executionRecoveryHash(task: Readonly<Execution>): string {
  return createHash("sha256").update(JSON.stringify(task)).digest("hex");
}

/** Expected contention with a control or another claimant, not a storage failure. */
export class ExecutionClaimConflict extends Error {}
/** New parent data invalidated a verdict, not the retained worker evidence. */
export class ExecutionDecisionConflict extends Error {}
export interface PlanHistoryRef { head: string; completed: number; segments: number; maxStepId: number }
export interface CompletedPlanStep { stepId: number; step: import("./dispatcher-sequential.js").PlanStep; outcome: import("./dispatcher-sequential.js").StepOutcome }
export interface PlanHistorySegment { previous?: PlanHistoryRef; steps: CompletedPlanStep[]; followUps: string[] }
export interface ExecutionFollowUp { task: string; role: "simple" | "medium" | "high"; reason: string; evidence: string }
export function validExecutionFollowUp(value: unknown): value is ExecutionFollowUp {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).every(key => ["task", "role", "reason", "evidence"].includes(key)) &&
    typeof v.task === "string" && !!v.task.trim() && v.task.length <= 4000 &&
    ["simple", "medium", "high"].includes(String(v.role)) &&
    typeof v.reason === "string" && !!v.reason.trim() && v.reason.length <= 500 &&
    typeof v.evidence === "string" && !!v.evidence.trim() && v.evidence.length <= 1000;
}
const decisionDataBytes = (receipts: readonly ExecutionDecision[]): number => Buffer.byteLength(JSON.stringify(receipts.map(d =>
  ({ requestId: d?.requestId, text: d?.text, ...(d?.followUp ? { followUp: d.followUp } : {}) }))), "utf8");
export interface ExecutionDecision {
  /** Explicit scoped additional work; the strategy must independently admit it. */
  followUp?: ExecutionFollowUp;
  /** Monotonic boundary revision, independent of bounded active-window length. */
  revision?: number;
  /** Explicit parent-authored replacement; originals remain in durable audit files. */
  supersedes?: string[];
  requestId: string;
  text: string;
  recordedAt: number;
  state: "pending" | "applied";
  /** Applied means delivered to a strategy boundary, NOT approved or completed. */
  appliedAt?: number;
  /** Non-secret claim correlation, never an ownership credential. */
  appliedClaim?: string;
}

/** Legacy receipts used their append position as revision. */
export function executionDecisionRevision(receipts: readonly ExecutionDecision[] = []): number {
  return receipts.reduce((revision, receipt, index) => Math.max(revision, receipt.revision ?? index + 1), 0);
}
function nextDecisionRevision(receipts: readonly ExecutionDecision[]): number {
  const next = executionDecisionRevision(receipts) + 1;
  if (!Number.isSafeInteger(next)) throw Error("Execution decision revision exhausted");
  return next;
}

/** Closed host-owned causes; exception/worker text is never persisted here. */
export type ExecutionDiagnosticCode = "runtime-failure" | "worker-failed" | "worker-cancelled" | "maintenance-blocked" | "manual-pause" | "deadline-expired" | "retry-exhausted" | "empty-result" | "assessment-blocked" | "assessment-waiting" | "assessment-stalled";
export class ExecutionDeadlineExpired extends Error {
  constructor() { super("deadline-expired: saved execution deadline has elapsed"); }
}
export class ExecutionAssessmentHold extends Error {
  constructor(readonly state: "blocked" | "waiting", readonly step: number, reason: string) { super(reason); }
}

/** Retained work made no observed progress; automatic transport retries cannot release it. */
export class ExecutionAssessmentStalled extends Error {
  constructor() { super("Assessment stopped without new evidence. New information or an explicit continuation is required; prior results are retained."); }
}

export class ExecutionWorkerFailure extends Error {
  constructor(readonly diagnosticCode: "worker-failed" | "worker-cancelled" | "maintenance-blocked") { super(diagnosticCode); }
}

export type ExecutionStatus = "ready" | "running" | "paused" | "blocked" | "completed" | "cancelled";
export interface Execution {
  /** Old paused failures require explicit resolution, not automatic retry on upgrade. */
  recoveryEnrollment?: "current" | "held-legacy";
  id: string;
  /** Host-captured parent mandate; never accepted from model tool arguments. */
  dependency?: { taskId: string; depth: number; original: string; expiresAt?: number; anchor?: import("./types.js").Inbound["completionAnchor"]; taskRef?: TaskRef;
    /** Scheduling snapshot; the live durable parent preference takes precedence. */
    priority?: import("./task-priority.js").TaskPriority };
  /** Host-captured address of the submitting turn (room/thread); never from model tool arguments. */
  origin?: import("./types.js").Address;
  requestId: string;
  /** Bounded active steering window; explicit consolidation archives originals durably. */
  decisions?: ExecutionDecision[];
  parent: string;
  input: string;
  strategy: string;
  strategyVersion: number;
  status: ExecutionStatus;
  execution?: ExecutionMetadata;
  /**
   * Host-pinned worker model pair, set only by trusted host submitters (the
   * benchmark runner). It bypasses dispatcher rules and complexity
   * classification and is honoured strictly, without role fallback.
   */
  pinned?: import("./model-roles.js").WorkerPin;
  classifier?: { requested: ExecutionMetadata; actual?: ExecutionMetadata };
  /** Retained across claims. Unknown sends require explicit reconciliation, never replay. */
  classifierReceipt?: import("./classifier-http.js").ClassifierReceipt & { token: string };
  checkpoint?: string;
  /** Host-scheduled read-only assessment retry, never a worker replay grant. */
  assessmentRetryAt?: number;
  /** Internal worker/strategy pauses have a durable dispatcher wake-up, not a parent nudge. */
  workerRetry?: { attempts: number; nextAt: number };
  /** Independent semantic hold: retain actionable attention while rechecking. */
  assessmentHold?: { state: "blocked" | "waiting"; step: number };
  contradictoryCompletionReopen?: { requestId: string; checkpointHash: string; text: string; at: number };
  /** Bounded host event dedup receipts, committed atomically with checkpoints. */
  checkpointNotices?: string[];
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
  controlRevision?: number;
  parentContinuation?: { requestId: string; executionHash: string; evidence: string; fingerprint: string; resumedManualPause?: boolean; at: number };
  terminalAt?: number;
  question?: { id: string; text: string; answer?: string; retainedAssessment?: boolean; eventId?: string };
  /** Durable receipt for the current stalled-assessment notification. */
  assessmentStalledEventId?: string;
  /** Question episode represented by the stalled notification. */
  assessmentStalledQuestionId?: string;
  /** Parent stop permanently revokes result delivery as well as execution. */
  parentStopped?: boolean;
  /** Unknown legacy ancestry after a task-scoped stop: evidence retained, no replay. */
  ownershipHold?: "unscoped-parent-stop";
  intent?: { key: string; replay: "safe" | "unsafe"; result?: string; route?: import("./model-roles.js").ModelPair };
  /** Last committed effect outcome, retained across the completion commit gap. */
  settledEffect?: { key: string; result: string };
}
export interface ExecutionEvent {
  id: string;
  executionId: string;
  parent: string;
  type: "accepted" | "status" | "question" | "assessment-stalled" | "result";
  text: string;
  /** State at event creation, not the potentially newer state at delivery. */
  status?: ExecutionStatus;
  /** Host-owned automatic wake-up, distinguishes backoff from a human attention hold. */
  automaticRetryAt?: number;
  requiresAttention?: boolean;
}
export interface TurnSettlement {
  taskOutcome?: TaskOutcome;
  taskPresentation?: { to: import("./types.js").Address };
  repetition?: import("./repetition-budget.js").RepetitionBudget;
  cronOutput?: string;
  cronCheckpoint?: import("./cron-checkpoint.js").CronCheckpoint;
  /** Observation only; never grants completion or continuation authority. */
  scheduledSilence?: { taskId: string; ref: TaskRef };
  outbox: import("./delivery/outbox.js").OutboxEntry[];
  continuation?: import("./types.js").Inbound["continuation"];
  goal?: import("./harness.js").Goal;
  consumed: string[];
}
export interface DurableTurn { id: string; sessionKey: string; state: "running" | "settled"; stopped?: boolean; settlement?: TurnSettlement; scheduledOccurrence?: { taskId: string; ref: TaskRef }; takeoverTaskId?: string; takeoverExecutionIds?: string[] }
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
  waitAuthorityDenials?: WaitAuthorityDenialReceipt[]; taskBook?: TaskBook }

/** One host owns this ledger under the Harness home lock. Mutations become visible
 * only after atomic durable replacement; task transitions and outgoing events share
 * the same commit. No timers, model calls, or plugin code run inside transactions. */
export class ExecutionStore {
  private data: Ledger = { version: 1, executions: [], events: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  /** Host admission check, run inside the serialized submission (never on a stale checkpoint). */
  submitGuard?: (parent: string, dependency: Execution["dependency"], origin: Execution["origin"]) => void;
  /** Resolves once every already queued mutation (e.g. a submission) has committed or failed. */
  quiesce(): Promise<void> { return this.queue.then(() => undefined, () => undefined); }
  /** Task ids of submissions admitted by submitGuard whose ledger write has not finished yet. */
  private readonly inflightTasks = new Map<string, number>();
  submissionInFlight(taskId: string): boolean { return (this.inflightTasks.get(taskId) ?? 0) > 0; }
  private readonly storage: PartitionedJson;
  private readonly dependencies: ExecutionDependencyStorage;
  private readonly taskBooks: TaskBookStorage;
  constructor(private readonly file: string, private readonly retention: {
    now?: () => number;
    protectedExecutions?: () => ReadonlySet<string>;
    enforceTaskAuthority?: boolean;
    /** Maximum total worker attempts (initial run + retries) per task before a manual-intervention hold. */
    workerRetryMax?: number | (() => number);
  } = {}) {
    this.dependencies = new ExecutionDependencyStorage(file);
    this.taskBooks = new TaskBookStorage(file);
    this.storage = new PartitionedJson(file, { executions: 1, events: 1, turns: 1, waitAuthorityDenials: 1 });
  }
  private now(): number { return this.retention.now?.() ?? Date.now(); }
  /** Configured automatic worker retry budget; invalid or missing values fall back to the default. */
  workerRecoveryLimit(): number {
    const value = this.retention.workerRetryMax;
    const resolved = typeof value === "function" ? value() : value;
    return typeof resolved === "number" && Number.isSafeInteger(resolved) && resolved >= 1 ? resolved : 12;
  }
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
      const stored = await this.storage.load();
      if (!stored) { this.loaded = true; return; }
      if (stored.version !== 1 && stored.version !== 2) throw Error("Unsupported execution ledger");
      if (stored.taskBook !== undefined && stored.taskBookRef !== undefined) throw Error("Ambiguous task book storage");
      const data = (stored.version === 2 ? { ...stored, version: 1, executions: await this.dependencies.hydrate(stored.executions as unknown[]) } : stored) as unknown as Ledger & { taskBookRef?: unknown };
      if (stored.taskBookRef !== undefined) { data.taskBook = await this.taskBooks.hydrate(stored.taskBookRef); delete data.taskBookRef; }
      if (data.version !== 1 || !Array.isArray(data.executions) || !Array.isArray(data.events)) throw Error("Unsupported execution ledger");
      if (data.waitAuthorityDenials !== undefined && (!Array.isArray(data.waitAuthorityDenials) ||
          data.waitAuthorityDenials.length > 100 || data.waitAuthorityDenials.some(r =>
            !r || !waitDenialReasons.includes(r.reason) || !Number.isSafeInteger(r.at) ||
            !Number.isSafeInteger(r.waitSequence) || (r.taskWaitSequence !== undefined && !Number.isSafeInteger(r.taskWaitSequence)) ||
            [r.taskId, r.turnId].some(id => id !== undefined && (typeof id !== "string" || id.length > 128)) ||
            Object.keys(r).some(key => !["reason", "taskId", "waitSequence", "taskWaitSequence", "turnId", "at"].includes(key)))))
        throw Error("Invalid wait authority denial receipt");
      if (data.taskBook !== undefined) validateTaskBook(data.taskBook);
      const ids = new Set<string>();
      for (const item of data.executions) {
        if (!item || typeof item.id !== "string" || ids.has(item.id) || typeof item.parent !== "string" ||
            typeof item.requestId !== "string" || typeof item.input !== "string" || typeof item.strategy !== "string" ||
            !Number.isSafeInteger(item.strategyVersion) || item.strategyVersion < 1 ||
            !["ready", "running", "paused", "blocked", "completed", "cancelled"].includes(item.status) ||
            !Number.isSafeInteger(item.restarts) || item.restarts < 0) throw Error("Invalid execution record");
        if (item.decisions !== undefined && (!Array.isArray(item.decisions) || item.decisions.length > 32 ||
            new Set(item.decisions.map(d => d?.requestId)).size !== item.decisions.length ||
            decisionDataBytes(item.decisions) > 16000 ||
            item.decisions.some(d => !d || !validDecisionInput(d.requestId, d.text) || !Number.isFinite(d.recordedAt) ||
              (d.followUp !== undefined && !validExecutionFollowUp(d.followUp)) ||
              (d.revision !== undefined && (!Number.isSafeInteger(d.revision) || d.revision < 1)) ||
              (d.supersedes !== undefined && (!Array.isArray(d.supersedes) || d.supersedes.length > 32 || d.supersedes.some(id => typeof id !== "string" || !validDecisionInput(id, "audit")))) ||
              !["pending", "applied"].includes(d.state) || (d.state === "applied"
                ? !Number.isFinite(d.appliedAt) || typeof d.appliedClaim !== "string" || !/^[a-f0-9]{64}$/.test(d.appliedClaim)
                : d.appliedAt !== undefined || d.appliedClaim !== undefined)))) throw Error("Invalid execution decisions");
        if (item.question !== undefined && (!item.question || typeof item.question.id !== "string" || !item.question.id ||
            typeof item.question.text !== "string" || !item.question.text.trim() || item.question.text.length > 8000 ||
            (item.question.answer !== undefined && (typeof item.question.answer !== "string" || item.question.answer.length > 8000)) ||
            (item.question.retainedAssessment !== undefined && typeof item.question.retainedAssessment !== "boolean") ||
            (item.question.eventId !== undefined && (typeof item.question.eventId !== "string" || !item.question.eventId)))) throw Error("Invalid execution question");
        if (item.assessmentStalledEventId !== undefined && (typeof item.assessmentStalledEventId !== "string" || !item.assessmentStalledEventId)) throw Error("Invalid assessment notification receipt");
        if (item.terminalAt !== undefined && (!Number.isSafeInteger(item.terminalAt) || item.terminalAt < 0)) throw Error("Invalid terminal timestamp");
        if (item.parentStopped !== undefined && typeof item.parentStopped !== "boolean") throw Error("Invalid parent stop marker");
        if (item.ownershipHold !== undefined && item.ownershipHold !== "unscoped-parent-stop") throw Error("Invalid ownership hold");
        if (item.origin !== undefined && !validAddress(item.origin)) throw Error("Invalid execution origin");
        if (item.checkpointNotices !== undefined && (!Array.isArray(item.checkpointNotices) || item.checkpointNotices.length > 32 ||
            item.checkpointNotices.some(k => typeof k !== "string" || !k || k.length > 100))) throw Error("Invalid checkpoint notice receipts");
        if (item.workerRetry !== undefined && (!item.workerRetry || !Number.isSafeInteger(item.workerRetry.attempts) ||
            item.workerRetry.attempts < 1 || !Number.isSafeInteger(item.workerRetry.nextAt) || item.workerRetry.nextAt < 0))
          throw Error("Invalid worker retry");
        if (item.assessmentHold !== undefined && (!item.assessmentHold ||
            !["blocked", "waiting"].includes(item.assessmentHold.state) ||
            !Number.isSafeInteger(item.assessmentHold.step) || item.assessmentHold.step < 0))
          throw Error("Invalid assessment hold");
        if (item.assessmentRetryAt !== undefined && (!Number.isSafeInteger(item.assessmentRetryAt) || item.assessmentRetryAt < 0))
          throw Error("Invalid assessment retry timestamp");
        for (const value of [item.checkpoint, item.result, item.token]) {
          if (value !== undefined && (typeof value !== "string" || value.length > 64000)) throw Error("Invalid execution field");
        }
        if (item.intent !== undefined && (!item.intent || typeof item.intent.key !== "string" || !item.intent.key.trim() ||
            !["safe", "unsafe"].includes(item.intent.replay))) throw Error("Invalid execution intent");
        if (item.settledEffect !== undefined && (!item.settledEffect || typeof item.settledEffect.key !== "string" || !item.settledEffect.key.trim() ||
            typeof item.settledEffect.result !== "string" || item.settledEffect.result.length > 64000)) throw Error("Invalid settled effect");
        if (item.classifierReceipt !== undefined) {
          const receipt = item.classifierReceipt;
          if (!receipt || !["initial", "fallback", "observed", "abandoned"].includes(receipt.phase) ||
              typeof receipt.token !== "string" || !receipt.token || !receipt.actual ||
              typeof receipt.actual.model !== "string" || typeof receipt.actual.thinking !== "string" ||
              (receipt.complexity !== undefined && (receipt.phase !== "observed" ||
                !["simple", "medium", "high"].includes(receipt.complexity)))) throw Error("Invalid classifier receipt");
        }
        if (item.controlRevision !== undefined && (!Number.isSafeInteger(item.controlRevision) || item.controlRevision < 0)) throw Error("Invalid execution control revision");
        if (item.parentContinuation !== undefined) {
          const receipt = item.parentContinuation;
          if (!receipt || typeof receipt.requestId !== "string" || !/^[a-zA-Z0-9_.:-]{1,160}$/.test(receipt.requestId) ||
              typeof receipt.executionHash !== "string" || !/^[a-f0-9]{64}$/.test(receipt.executionHash) ||
              typeof receipt.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(receipt.fingerprint) ||
              receipt.resumedManualPause !== undefined && typeof receipt.resumedManualPause !== "boolean" ||
              typeof receipt.evidence !== "string" || !receipt.evidence.trim() || receipt.evidence.length > 8000 ||
              !Number.isSafeInteger(receipt.at) || receipt.at < 0) throw Error("Invalid parent continuation receipt");
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
            !["accepted", "status", "question", "assessment-stalled", "result"].includes(event.type) || typeof event.text !== "string") throw Error("Invalid execution event");
        if (event.automaticRetryAt !== undefined && (event.type !== "status" ||
            !Number.isSafeInteger(event.automaticRetryAt) || event.automaticRetryAt <= 0))
          throw Error("Invalid automatic retry event");
        if (event.requiresAttention !== undefined && typeof event.requiresAttention !== "boolean")
          throw Error("Invalid event attention flag");
        eventIds.add(event.id);
      }
      // Upgrade only a still-pending legacy outbox receipt that exactly matches
      // the saved unanswered question. The next commit (including ack) saves it.
      for (const task of data.executions) {
        if (task.question && task.question.answer === undefined && !task.question.eventId) {
          const events = data.events.filter(event => event.executionId === task.id && event.parent === task.parent &&
            event.type === "question" && event.text === `Question ${task.question!.id}: ${task.question!.text}`);
          if (events.length === 1) task.question.eventId = events[0]!.id;
        }
      }
      if (data.turns !== undefined) {
        if (!Array.isArray(data.turns)) throw Error("Invalid durable turns");
        const turnIds = new Set<string>();
        for (const turn of data.turns) {
          if (!turn || typeof turn.id !== "string" || !turn.id || turnIds.has(turn.id) ||
              typeof turn.sessionKey !== "string" || !turn.sessionKey || !["running", "settled"].includes(turn.state)) throw Error("Invalid durable turn");
          if (turn.stopped !== undefined && typeof turn.stopped !== "boolean") throw Error("Invalid turn stop marker");
          if (turn.takeoverTaskId !== undefined && (typeof turn.takeoverTaskId !== "string" || !turn.takeoverTaskId)) throw Error("Invalid takeover task");
          if (turn.takeoverExecutionIds !== undefined && (!Array.isArray(turn.takeoverExecutionIds) || turn.takeoverExecutionIds.some(id => typeof id !== "string" || !id))) throw Error("Invalid takeover executions");
          turnIds.add(turn.id);
          if (turn.state === "settled") this.validateSettlement(turn.sessionKey, turn.settlement);
          else if (turn.settlement !== undefined) throw Error("Unexpected turn settlement");
        }
      }
      for (const task of data.executions) freezeExecutionDependency(task.dependency);
      this.data = data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.loaded = true;
  }
  private mutate<T>(fn: (draft: Ledger) => T | Promise<T>, shouldCommit?: () => boolean, unchanged?: (data: Ledger) => boolean): Promise<T> {
    const next = this.queue.catch(() => {}).then(async () => {
      if (!this.loaded) throw Error("Execution store not loaded");
      this.storage.assertWritable();
      // Only void idempotent mutations use this predicate, inside the queue and
      // after ownership validation. Do not clone the ledger for a proven no-op.
      if (unchanged?.(this.data)) return undefined as T;
      // Dependency snapshots are immutable host-owned evidence. Clone mutable
      // ledger state, but share frozen dependencies rather than copying tens of
      // MB on every status/turn barrier. Preserve exact key order for fences.
      const draft = structuredClone({ ...this.data, executions: this.data.executions.map(({ dependency, ...task }) => task) }) as Ledger;
      draft.executions = draft.executions.map((task, index) => Object.fromEntries(Object.keys(this.data.executions[index]!).map(key =>
        [key, key === "dependency" ? this.data.executions[index]!.dependency : task[key as keyof Execution]])) as unknown as Execution);
      const result = await fn(draft);
      // Only explicitly tracked idempotent operations may omit an unchanged
      // commit, AFTER joining the serialized queue and checking writability.
      // Never decide from an unlocked snapshot before preceding writes settle.
      if (shouldCommit && !shouldCommit()) return structuredClone(result);
      await mkdir(path.dirname(this.file), { recursive: true });
      // Preserve immutable v2 dependency evidence and binding validation; partition
      // only the lightweight stored rows, never duplicate full dependencies in them.
      await this.storage.preserveLegacy();
      const executions = await this.dependencies.stage(draft.executions);
      const taskBookRef = draft.taskBook && await this.taskBooks.stage(draft.taskBook);
      const { taskBook: _taskBook, ...root } = draft;
      await this.storage.save({ ...root, version: 2, executions, ...(taskBookRef ? { taskBookRef } : {}) }, true);
      this.data = draft;
      return structuredClone(result);
    });
    this.queue = next;
    return next;
  }
  /** Await all accepted ledger writes; failure must not produce a maintenance lease. */
  async drain(): Promise<void> { await this.queue; }

  private event(draft: Ledger, task: Execution, type: ExecutionEvent["type"], text: string, attention = false): void {
    const id = randomUUID();
    // Retain the exact question event after outbox acknowledgement. The durable
    // Main inbox must remain verifiable across that acknowledgement and restart.
    if (type === "question" && task.question) task.question.eventId = id;
    if (type === "assessment-stalled") {
      task.assessmentStalledEventId = id;
      task.assessmentStalledQuestionId = task.question?.id;
    }
    draft.events.push({ id, executionId: task.id, parent: task.parent, type, text, status: task.status,
      ...(attention ? { requiresAttention: true } : {}),
      ...(type === "status" && !task.parentStopped && !(task.question && task.question.answer === undefined) &&
        task.workerRetry && ["runtime-failure", "worker-failed"].includes(task.diagnosticCode ?? "") &&
        ["paused", "blocked", "ready"].includes(task.status) ? { automaticRetryAt: task.workerRetry.nextAt } : {}) });
  }
  /** Exact host-owned question receipt, never an arbitrary host-input mandate. */
  questionAllowed(input: import("./types.js").Inbound, activeAnsweredTurn = false): boolean {
    const receipt = input.hostEvent?.question;
    if (input.source !== "host" || !receipt || !receipt.eventId || !receipt.id ||
        input.id !== `dispatch-event:${receipt.eventId}`) return false;
    const task = this.data.executions.find(item => item.id === input.hostEvent!.executionId && item.parent === input.sessionKey);
    const question = task?.question;
    return !!task && !!question && question.id === receipt.id && question.eventId === receipt.eventId &&
      (question.answer === undefined ? task.status === "paused" : activeAnsweredTurn && task.status !== "cancelled") && !task.parentStopped && !task.ownershipHold &&
      this.executionTaskAllowed(task) &&
      (task.dependency?.expiresAt === undefined || task.dependency.expiresAt > this.now()) &&
      (!task.intent || question.retainedAssessment === true) &&
      input.text === this.questionText(task.id, question);
  }
  /** activeAdmittedTurn: the SAME already admitted turn may keep its authority after
   * its own steering decision woke the held execution (blocked -> ready). A queued or
   * replayed notice never gets this: it requires the exact stalled hold. Stop, pause,
   * cancel, ownership hold, expiry and a changed question still revoke. */
  assessmentStalledAllowed(input: import("./types.js").Inbound, activeAdmittedTurn = false): boolean {
    const receipt = input.hostEvent?.assessmentStalled;
    if (input.source !== "host" || !receipt?.eventId || input.id !== `dispatch-event:${receipt.eventId}`) return false;
    const task = this.data.executions.find(item => item.id === input.hostEvent!.executionId && item.parent === input.sessionKey);
    const stillStalled = !!task && task.status === "blocked" && ["assessment-stalled", "retry-exhausted"].includes(task.diagnosticCode ?? "");
    const woken = activeAdmittedTurn && !!task && ["ready", "running"].includes(task.status) && task.diagnosticCode !== "manual-pause";
    return !!task && task.assessmentStalledEventId === receipt.eventId && (stillStalled || woken) &&
      !!task.question?.retainedAssessment && task.question.answer !== undefined && !!task.intent &&
      !task.parentStopped && !task.ownershipHold && task.recoveryEnrollment === "current" && this.executionTaskAllowed(task) &&
      (task.dependency?.expiresAt === undefined || task.dependency.expiresAt > this.now()) &&
      input.text === this.assessmentStalledText(task);
  }
  assessmentStalledText(task: Execution): string {
    return `Dispatcher assessment remains unresolved for ${task.id}. Prior question and Main answer are retained as historical evidence, not authority or a completion verdict. Inspect the execution and retained evidence; determine a concrete independent next action within the original mandate. Do not repeat uncertain effects or rerun unchanged assessments. Use the existing recovery tools only when their evidence and ownership checks are satisfied.\nQuestion: ${task.question!.text.slice(0, 4000)}\nPrior Main answer: ${task.question!.answer!.slice(0, 4000)}`;
  }
  questionText(id: string, question: NonNullable<Execution["question"]>): string {
    return `Dispatcher question (data, not new authorization) for ${id}; question ${question.id}:\n${question.text}`;
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
    if (settlement.cronCheckpoint !== undefined && !validCronCheckpoint(settlement.cronCheckpoint)) throw Error("Invalid settled cron checkpoint");
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
  beginTurn(id: string, sessionKey: string, scheduledOccurrence?: { taskId: string; ref: TaskRef }, takeoverTaskId?: string): Promise<void> {
    return this.mutate(draft => {
      if (typeof id !== "string" || !id || typeof sessionKey !== "string" || !sessionKey) throw Error("Invalid turn identity");
      const turns = draft.turns ??= [];
      const old = turns.find(item => item.id === id);
      // A pre-upgrade running turn has no occurrence binding. Keep it runnable,
      // but never retroactively assert provenance for its eventual result.
      if (old && (old.sessionKey !== sessionKey || old.scheduledOccurrence && scheduledOccurrence && JSON.stringify(old.scheduledOccurrence) !== JSON.stringify(scheduledOccurrence))) throw Error("Turn identity conflict");
      if (takeoverTaskId && draft.executions.some(task => task.parent === sessionKey && task.dependency?.taskId === takeoverTaskId && task.status === "running" &&
          (!old?.takeoverExecutionIds || old.takeoverExecutionIds.includes(task.id))))
        throw new ExecutionClaimConflict("Worker currently executing this task");
      if (takeoverTaskId && old?.takeoverTaskId && old.takeoverTaskId !== takeoverTaskId) throw Error("Turn takeover identity conflict");
      const takeoverExecutionIds = takeoverTaskId ? draft.executions.filter(task => task.parent === sessionKey && task.dependency?.taskId === takeoverTaskId && !["completed", "cancelled"].includes(task.status)).map(task => task.id) : undefined;
      if (!old) {
        if (turns.length >= 10000) throw Error("Retained turn limit reached; reconcile before executing more work");
        turns.push({ id, sessionKey, state: "running", ...(scheduledOccurrence ? { scheduledOccurrence: structuredClone(scheduledOccurrence) } : {}), ...(takeoverTaskId ? { takeoverTaskId, takeoverExecutionIds } : {}) });
      } else if (takeoverTaskId && old.state === "running") {
        old.takeoverTaskId = takeoverTaskId;
        old.takeoverExecutionIds ??= takeoverExecutionIds;
      } else if (old.state === "running" && old.takeoverTaskId) {
        // Replayed input may no longer be a takeover (for example an explicit
        // independent admission). A previous process must not retain its fence.
        delete old.takeoverTaskId;
        delete old.takeoverExecutionIds;
      }
    });
  }
  /** Release only the execution fence after the runtime has actually exited.
   * The durable turn remains available for the existing inbox retry. */
  releaseTurnTakeover(id: string, sessionKey: string): Promise<void> {
    return this.mutate(draft => {
      const turn = draft.turns?.find(item => item.id === id);
      if (turn && turn.sessionKey !== sessionKey) throw Error("Turn identity conflict");
      if (turn?.state === "running") {
        delete turn.takeoverTaskId;
        delete turn.takeoverExecutionIds;
      }
    });
  }
  private stoppedSettlement(settlement: TurnSettlement): TurnSettlement {
    return { ...settlement, cronCheckpoint: undefined, scheduledSilence: undefined, continuation: undefined, outbox: settlement.outbox.map(entry => ({
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
  settleTurn(id: string, sessionKey: string, settlement: TurnSettlement): Promise<TurnSettlement> {
    return this.mutate(async draft => {
      const turn = draft.turns?.find(item => item.id === id && item.sessionKey === sessionKey);
      if (!turn) throw Error("Unknown durable turn");
      this.validateSettlement(sessionKey, settlement);
      if (turn.state === "settled") throw Error("Turn already settled");
      const committed = structuredClone(turn.stopped ? this.stoppedSettlement(settlement) : settlement);
      if (settlement.taskOutcome && !turn.stopped) {
        if (!draft.taskBook || settlement.taskOutcome.eventId !== id) throw Error("Task book or outcome identity unavailable");
        const order = draft.taskBook.tasks.find(t => t.id === settlement.taskOutcome!.ref.id);
        const priorPlan = JSON.stringify(order?.plan), priorRevision = order?.revision;
        if (order) await this.archiveTaskReceipts(order);
        const archived = order && await this.archivedTaskReceipt(order.id, settlement.taskOutcome.eventId);
        if (archived && archived.digest !== taskDigest(settlement.taskOutcome)) throw Error("Archived outcome identity conflict");
        if (!archived) commitTaskOutcome(draft.taskBook, settlement.taskOutcome, this.now());
        // The checklist is pull-only for chat operators (/orders show): re-posting the
        // whole order on every plan edit floods the conversation. API callers still
        // receive it as nonterminal progress; their run remains owned by its result.
        if (order && order.revision !== priorRevision && priorPlan !== JSON.stringify(order.plan) && settlement.taskPresentation?.to.channel === "api") {
          if (!validAddress(settlement.taskPresentation.to)) throw Error("Invalid task presentation target");
          committed.outbox.push({ id: `${id}:task-plan`, sessionKey, to: structuredClone(settlement.taskPresentation.to), text: renderTask(order),
            presentation: "progress" as const });
        }
        validateTaskBook(draft.taskBook);
      }
      // Legacy turns lack a pre-execution binding: resume them without inventing
      // occurrence-specific evidence. The result itself may still be processed.
      if (committed.scheduledSilence && !turn.scheduledOccurrence) committed.scheduledSilence = undefined;
      if (committed.scheduledSilence) {
        const { taskId, ref } = committed.scheduledSilence;
        const book = draft.taskBook;
        const binding = book?.bindings.find(b => b.sessionKey === sessionKey && b.taskId === taskId);
        const order = book?.tasks.find(t => t.id === ref.id);
        if (!turn.scheduledOccurrence || turn.scheduledOccurrence.taskId !== taskId || turn.scheduledOccurrence.ref.id !== ref.id ||
            turn.scheduledOccurrence.ref.generation !== ref.generation || !order?.scheduled || !binding || binding.ref.id !== ref.id || binding.ref.generation !== ref.generation ||
            ref.generation > order.generation || !sessionKey.startsWith("cron:")) throw Error("Invalid scheduled silence provenance");
        await this.archiveTaskReceipts(order);
        const receiptId = `silence:${id}`;
        const digest = taskDigest({ turnId: id, sessionKey, taskId, ref, result: "NO_REPLY" });
        const old = order.receipts.find(r => r.id === receiptId) ?? await this.archivedTaskReceipt(order.id, receiptId);
        if (old && old.digest !== digest) throw Error("Scheduled silence identity conflict");
        if (!old) order.receipts.push({ id: receiptId, kind: "scheduled-silence", sourceId: id, at: this.now(),
          generation: ref.generation, revision: order.revision, digest, reason: "NO_REPLY" });
        validateTaskBook(book!);
      }
      turn.state = "settled";
      turn.settlement = committed;
      return committed;
    });
  }
  private taskReceiptDirectory(id: string): string { return path.join(`${this.file}.tasks`, createHash("sha256").update(id).digest("hex")); }
  private async archivedTaskReceipt(id: string, eventId: string): Promise<TaskReceipt | undefined> {
    try {
      const value = JSON.parse(await readFile(path.join(this.taskReceiptDirectory(id), `${createHash("sha256").update(eventId).digest("hex")}.json`), "utf8"));
      if (value.taskId !== id || value.receipt?.id !== eventId) throw Error("Invalid task receipt archive identity");
      return value.receipt;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  private async archiveTaskReceipts(task: CoreTask): Promise<void> {
    if (task.receipts.length < 480) return;
    const records = task.receipts.slice(0, -128);
    const directory = this.taskReceiptDirectory(task.id); await mkdir(directory, { recursive: true, mode: 0o700 });
    const save = async (name: string, value: unknown) => {
      const file = path.join(directory, name), raw = JSON.stringify(value);
      try { await writeFileDurableExclusive(file, raw); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(file, "utf8") !== raw) throw error; }
    };
    for (const record of records) await save(`${createHash("sha256").update(record.id).digest("hex")}.json`, { taskId: task.id, receipt: record });
    const segment = { taskId: task.id, previous: task.receiptArchive ?? null, receipts: records };
    const head = taskDigest(segment); await save(`segment-${head}.json`, segment);
    await syncDirStrict(directory); await syncDirStrict(path.dirname(directory)); await syncDirStrict(path.dirname(path.dirname(directory)));
    task.receiptArchive = { head, count: (task.receiptArchive?.count ?? 0) + records.length };
    task.receipts = task.receipts.slice(-128);
  }
  /** Core operator authority shares the execution/turn atomic commit, not a second scheduler. */
  tasks(): CoreTask[] { return structuredClone(this.data.taskBook?.tasks ?? []); }
  coreTask(id: string): CoreTask | undefined { return structuredClone(this.data.taskBook?.tasks.find(t => t.id === id)); }
  taskBinding(sessionKey: string, taskId: string): TaskRef | undefined {
    return structuredClone(this.data.taskBook?.bindings.find(b => b.sessionKey === sessionKey && b.taskId === taskId)?.ref);
  }
  taskIsOpen(ref: TaskRef): boolean { return !!this.data.taskBook && taskOpen(this.data.taskBook, ref); }
  executionTaskAllowed(execution: Execution): boolean {
    return execution.dependency?.taskRef ? this.taskIsOpen(execution.dependency.taskRef) : !this.retention.enforceTaskAuthority;
  }
  enrollTask(sessionKey: string, taskId: string, original: string, sourceId: string, kind: "operator" | "schedule" | "legacy"): Promise<TaskRef> {
    return this.mutate(draft => {
      const book = draft.taskBook ??= { tasks: [], bindings: [] };
      const ref = enrollTask(book, { sessionKey, taskId }, original, sourceId, kind, this.now());
      for (const execution of draft.executions) if (execution.parent === sessionKey && execution.dependency?.taskId === taskId && !execution.dependency.taskRef) {
        if (execution.dependency.original !== original) throw Error("Execution/task original scope conflict");
        execution.dependency = { ...execution.dependency, taskRef: structuredClone(ref) };
      }
      validateTaskBook(book); return ref;
    });
  }
  decideTask(ref: TaskRef, revision: number, eventId: string, action: "close" | "reopen" | "clarify", text: string, supersedes?: TaskRef): Promise<TaskRef> {
    return this.mutate(async draft => {
      if (!draft.taskBook) throw Error("Task book unavailable");
      const order = draft.taskBook.tasks.find(t => t.id === ref.id);
      const archived = order && await this.archivedTaskReceipt(order.id, eventId);
      if (archived) {
        if (archived.digest !== taskDigest([ref.id, action, text])) throw Error("Archived operator receipt identity conflict");
        return { id: ref.id, generation: archived.generation };
      }
      if (order) await this.archiveTaskReceipts(order);
      const next = operatorTransition(draft.taskBook, ref, revision, eventId, action, text, this.now());
      if (supersedes && supersedes.id !== ref.id && taskOpen(draft.taskBook, supersedes)) {
        const provisional = draft.taskBook.tasks.find(t => t.id === supersedes.id)!;
        await this.archiveTaskReceipts(provisional);
        operatorTransition(draft.taskBook, supersedes, provisional.revision, `joined:${eventId}`, "close", `Input belongs to order ${ref.id}; not a separate continuing mandate`, this.now());
      }
      validateTaskBook(draft.taskBook); return next;
    });
  }
  /** Same-owner exact duplicate retirement: both authority fences and child
   * custody are checked in the writer transaction, not against a stale snapshot. */
  retireScheduledDuplicate(parent: string, duplicate: TaskRef, keeper: TaskRef, revision: number,
    keeperRevision: number, eventId: string, reason: string, boundary: () => boolean): Promise<void> {
    return this.mutate(draft => {
      const book = draft.taskBook;
      const order = book?.tasks.find(t => t.id === duplicate.id), kept = book?.tasks.find(t => t.id === keeper.id);
      if (!book || !order || !kept || duplicate.id === keeper.id || !order.scheduled || !kept.scheduled ||
          order.original !== kept.original) throw Error("Exact scheduled duplicate pair unavailable");
      const receipt = order.receipts.find(r => r.id === eventId);
      if (receipt) {
        if (receipt.digest !== taskDigest([duplicate.id, "close", reason])) throw Error("Duplicate retirement receipt conflict");
        return;
      }
      if (!boundary()) throw Error("Duplicate repair idle boundary changed");
      const bindings = book.bindings.filter(b => b.sessionKey === parent &&
        (b.ref.id === duplicate.id && b.ref.generation === duplicate.generation || b.ref.id === keeper.id && b.ref.generation === keeper.generation));
      if (!bindings.some(b => b.ref.id === duplicate.id) || !bindings.some(b => b.ref.id === keeper.id) ||
          !taskOpen(book, duplicate) || !taskOpen(book, keeper) || order.revision !== revision || kept.revision !== keeperRevision ||
          draft.executions.some(e => e.parent === parent &&
            (!e.dependency?.taskId || bindings.some(b => b.taskId === e.dependency?.taskId)) &&
            (!['completed', 'cancelled'].includes(e.status) || !!e.intent))) throw Error("Duplicate authority or custody changed");
      operatorTransition(book, duplicate, revision, eventId, "close", reason, this.now());
      validateTaskBook(book);
    });
  }

  bindTask(sessionKey: string, taskId: string, ref: TaskRef): Promise<void> {
    return this.mutate(draft => {
      if (!draft.taskBook || !taskOpen(draft.taskBook, ref)) throw Error("Open current operator task required");
      const binding = draft.taskBook.bindings.find(b => b.sessionKey === sessionKey && b.taskId === taskId);
      if (binding) { if (binding.ref.id !== ref.id) throw Error("Task binding identity conflict"); binding.ref = structuredClone(ref); }
      else draft.taskBook.bindings.push({ sessionKey, taskId, ref: structuredClone(ref) });
      validateTaskBook(draft.taskBook);
    });
  }
  expireTasks(inactivityMs: number): Promise<string[]> {
    return this.mutate(async draft => {
      if (!draft.taskBook) return [];
      for (const task of draft.taskBook.tasks) await this.archiveTaskReceipts(task);
      const ids = expireInactiveTasks(draft.taskBook, this.now(), inactivityMs); validateTaskBook(draft.taskBook); return ids;
    });
  }
  /** Conversation-scoped durable lookup, including compacted terminal records. */
  async findRequest(parent: string, requestId: string): Promise<Execution | undefined> {
    const task = this.data.executions.find(item => item.parent === parent && item.requestId === requestId)
      ?? await this.archived(parent, requestId);
    return task ? structuredClone(task) : undefined;
  }
  /** Read-only logical snapshot for diagnostics; disk format may contain refs. */
  snapshot(): Ledger { if (!this.loaded) throw Error("Execution store not loaded"); return structuredClone(this.data); }
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
  submit(parent: string, requestId: string, input: string, strategy: string, strategyVersion = 1, dependency?: Execution["dependency"], pinned?: Execution["pinned"], origin?: Execution["origin"]): Promise<Execution> {
    let admitted: string | undefined;
    return this.mutate(async draft => {
      if (![parent, requestId, input, strategy].every(value => typeof value === "string" && value.trim()) || input.length > 1024 * 1024 ||
          !Number.isSafeInteger(strategyVersion) || strategyVersion < 1) throw Error("Invalid execution submission");
      if (this.retention.enforceTaskAuthority && !dependency?.taskRef) throw Error("Operator task authority required for delegation");
      if (dependency?.taskRef && (!draft.taskBook || !taskOpen(draft.taskBook, dependency.taskRef))) throw Error("Operator task is closed, unresolved or stale");
      const old = draft.executions.find(item => item.parent === parent && item.requestId === requestId) ?? await this.archived(parent, requestId);
      if (old) {
        if (old.dependency?.taskId !== dependency?.taskId) throw Error("execution-context-mismatch: requestId belongs to another task");
        if (dependency?.expiresAt !== undefined && dependency.expiresAt < (old.dependency?.expiresAt ?? Infinity))
          throw Error("execution-context-mismatch: retained request has a looser mandate deadline; reconcile its authority before retrying");
        if (old.input !== input || old.strategy !== strategy || old.strategyVersion !== strategyVersion ||
            JSON.stringify(old.pinned ?? null) !== JSON.stringify(pinned ?? null)) throw Error("Conflicting execution request ID");
        return old;
      }
      if (draft.executions.length >= 2000) throw Error("Retained execution limit reached; archive only after reconciliation");
      this.submitGuard?.(parent, dependency, origin);
      // Visible synchronously from admission until the write finished (see finally below).
      if (dependency?.taskId) { const id = dependency.taskId; this.inflightTasks.set(id, (this.inflightTasks.get(id) ?? 0) + 1);
        admitted = id; }
      if (origin !== undefined && !validAddress(origin)) throw Error("Invalid execution origin");
      const task: Execution = { recoveryEnrollment: "current", dependency: structuredClone(dependency), ...(origin ? { origin: structuredClone(origin) } : {}), pinned: structuredClone(pinned), id: randomUUID(), parent, requestId, input, strategy, strategyVersion, status: "ready", restarts: 0 };
      draft.executions.push(task);
      this.event(draft, task, "accepted", "Auftrag angenommen");
      return task;
    }).finally(() => {
      if (!admitted) return;
      const n = (this.inflightTasks.get(admitted) ?? 1) - 1;
      if (n > 0) this.inflightTasks.set(admitted, n); else this.inflightTasks.delete(admitted);
    });
  }
  /** Persist before dispatcher startup: accepted/interrupted work stays current;
   * old paused/blocked failures are retained without automatic re-enrollment. */
  holdLegacyRecovery(): Promise<void> {
    return this.mutate(draft => {
      for (const task of draft.executions) {
        if (task.recoveryEnrollment) continue;
        task.recoveryEnrollment = task.status === "running" ||
          task.status === "ready" && !task.workerRetry && !task.diagnosticCode ? "current" : "held-legacy";
      }
    });
  }
  private parentOwnsTask(task: Readonly<Execution>, turns = this.data.turns): boolean {
    // A stop request revokes authority but does not mean the runtime has exited.
    // Keep the fence until settlement or startup reconciliation removes the turn.
    return !!task.dependency?.taskId && !!turns?.some(turn => turn.state === "running" &&
      turn.sessionKey === task.parent && turn.takeoverTaskId === task.dependency?.taskId &&
      (turn.takeoverExecutionIds === undefined || turn.takeoverExecutionIds.includes(task.id)));
  }
  parentTakeoverActive(task: Readonly<Execution>): boolean { return this.parentOwnsTask(task); }
  /** Current policy is supplied by the trusted host registry, never by model input.
   * Recovery is not itself a replay grant: policy is checked again at claim time. */
  assessmentDue(task: Readonly<Execution>): boolean {
    return !this.parentOwnsTask(task) && !task.ownershipHold && (task.assessmentRetryAt === undefined || task.assessmentRetryAt <= this.now()) &&
      (task.workerRetry === undefined || task.workerRetry.nextAt <= this.now());
  }
  claim(id: string, current?: RecoveryStrategy & { strategy: string }, policy?: ExecutionRecoveryPolicy): Promise<Execution> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (this.retention.enforceTaskAuthority && !task.dependency?.taskRef) throw new ExecutionClaimConflict("Operator task authority missing");
      if (task.dependency?.taskRef && (!draft.taskBook || !taskOpen(draft.taskBook, task.dependency.taskRef))) throw new ExecutionClaimConflict("Operator task is closed or stale");
      if (this.parentOwnsTask(task, draft.turns))
        throw new ExecutionClaimConflict("Parent is executing this task");
      if (task.recoveryEnrollment === "held-legacy" || task.status !== "ready" || !this.assessmentDue(task))
        throw new ExecutionClaimConflict("Execution not ready");
      const reason = task.intent ? recoveryBlock(task, current?.strategy === task.strategy ? current : undefined, policy)
        : task.workerRetry ? policy?.evaluate(structuredClone(task)) : undefined;
      if (reason) throw Error(reason);
      const claimedRecoveryAction = task.recoveryGrant?.restarts === task.restarts ? task.recoveryGrant.action : undefined;
      delete task.recoveryGrant;
      delete task.execution; // A new attempt has no observed selection yet.
      delete task.classifier;
      const assessmentRetry = task.assessmentRetryAt !== undefined;
      delete task.assessmentRetryAt;
      task.token = randomUUID();
      task.status = "running";
      if (!assessmentRetry) this.event(draft, task, "status", "Ausführung gestartet");
      return { ...task, claimedRecoveryAction };
    });
  }
  /** Trusted strategy yields its slot while retaining settled evidence and intent.
   * The next claim must reconcile, never start an opaque worker again. */
  deferAssessment(id: string, token: string, nextAt: number, decisionRevision?: number): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      this.checkDecisionRevision(task, decisionRevision);
      if (!Number.isSafeInteger(nextAt) || nextAt <= this.now() || !task.checkpoint || !task.intent)
        throw Error("Invalid assessment deferral");
      task.assessmentRetryAt = nextAt;
      task.recoverySession ??= `dispatch:${task.id}:${token}`;
      task.status = "ready";
      delete task.token;
    });
  }
  /** A committed sequential step can release capacity without replaying effects. */
  yieldStep(id: string, token: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      if (task.intent || !task.checkpoint) throw Error("Cannot yield an unsettled step");
      task.status = "ready";
      delete task.token;
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
          ["observed", "abandoned"].includes(previous.phase) || receipt.phase === "abandoned" || (receipt.phase === "fallback" && previous.phase !== "initial")) {
        throw Error("Classifier receipt cannot be replayed");
      }
      task.classifierReceipt = { ...receipt, token };
    });
  }
  /** Commit default routing without replaying an interrupted, tool-free classifier. */
  abandonClassifier(id: string, token: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      if (task.parentStopped || task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now())
        throw new ExecutionDeadlineExpired();
      if (!this.canAbandonClassifier(task)) throw Error("Classifier cannot be abandoned after worker effects");
      task.classifierReceipt = { ...task.classifierReceipt!, phase: "abandoned" };
    });
  }
  private canAbandonClassifier(task: Execution, strategy?: RecoveryStrategy): boolean {
    return task.strategy === "direct" && task.strategyVersion === 1 && !task.intent && !task.settledEffect &&
      !!task.classifierReceipt && ["initial", "fallback"].includes(task.classifierReceipt.phase) &&
      (!strategy || strategy.version === task.strategyVersion && !!strategy.reconcile);
  }
  checkpoint(id: string, token: string, checkpoint: string, notice?: { key: string; text: string }, decisionRevision?: number): Promise<void> {
    return this.mutate(draft => {
      if (typeof checkpoint !== "string" || checkpoint.length > 64000) throw Error("Invalid checkpoint");
      const task = this.owned(draft, id, token); this.checkDecisionRevision(task, decisionRevision);
      if (decisionRevision !== undefined && task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now()) throw new ExecutionDeadlineExpired();
      if (notice) {
        if (typeof notice.key !== "string" || !notice.key || notice.key.length > 100 ||
            typeof notice.text !== "string" || !notice.text || notice.text.length > 8000) throw Error("Invalid checkpoint notice");
        const receipts = task.checkpointNotices ??= [];
        if (!receipts.includes(notice.key)) {
          if (receipts.length >= 32) throw Error("Checkpoint notice receipt limit exceeded");
          receipts.push(notice.key);
          this.event(draft, task, "status", notice.text);
        }
      }
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
  intent(id: string, token: string, key: string, replay: "safe" | "unsafe", route?: import("./model-roles.js").ModelPair, decisionRevision?: number): Promise<void> {
    if (route !== undefined && (!route || typeof route !== "object" || Array.isArray(route) || Object.keys(route).some(k => !["model", "thinking"].includes(k)) ||
        (route.model !== undefined && (typeof route.model !== "string" || route.model.length > 200)) ||
        (route.thinking !== undefined && (typeof route.thinking !== "string" || route.thinking.length > 40)))) throw Error("Invalid selected route");
    return this.mutate(draft => {
      if (typeof key !== "string" || !key.trim() || !["safe", "unsafe"].includes(replay)) throw Error("Invalid effect intent");
      const task = this.owned(draft, id, token);
      this.checkDecisionRevision(task, decisionRevision);
      if (task.intent) throw Error("Resolve previous effect intent first");
      task.intent = { key, replay, ...(route ? { route: structuredClone(route) } : {}) };
    });
  }
  settleIntent(id: string, token: string, key: string, result: string, checkpoint: string, decisionRevision?: number): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      this.checkDecisionRevision(task, decisionRevision);
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
  ask(id: string, token: string, text: string, retainedAssessment = false): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      // Trusted strategy may ask about retained review evidence. The intent
      // stays unresolved; an answer cannot settle it or authorize effect replay.
      if (task.intent && !retainedAssessment) throw Error("Cannot ask with unresolved effect intent");
      if (retainedAssessment) {
        const saved = task.checkpoint ? JSON.parse(task.checkpoint) : undefined;
        if (!saved?.assessment?.mainClarification || saved.assessment.index !== saved.outcomes?.length ||
            typeof saved.assessment.reply !== "string" || !saved.assessment.reply.trim())
          throw Error("Retained assessment checkpoint required");
      }
      if (typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid question");
      // A new question starts a distinct assessment episode. The previous
      // stalled receipt belongs to the old question and must not suppress a
      // later notification for this one. This does not release the intent.
      delete task.assessmentStalledEventId;
      delete task.assessmentStalledQuestionId;
      task.question = { id: randomUUID(), text, ...(retainedAssessment ? { retainedAssessment: true } : {}) };
      task.status = "paused";
      delete task.workerRetry;
      delete task.assessmentHold;
      delete task.token;
      this.event(draft, task, "question", `Question ${task.question.id}: ${text}`);
    });
  }
  /** Parent is supplied by the authenticated host session, never tool arguments.
   * wake is trusted strategy code proving a retained assessment boundary.
   * Recording never changes a token, clears intent, or grants replay authority. */
  recordDecision(parent: string, id: string, requestId: string, text: string,
      wake?: (task: Readonly<Execution>) => boolean, expectedRevision?: number): Promise<ExecutionDecision> {
    return this.mutate(async draft => {
      if (/^(dispatch|subagent):/.test(parent)) throw Error("Nested worker decisions are disabled");
      if (!validDecisionInput(requestId, text)) throw Error("Invalid decision requestId or text");
      const task = this.find(draft, id);
      if (task.parent !== parent || task.parentStopped || ["completed", "cancelled"].includes(task.status))
        throw Error("Execution cannot accept a decision in this conversation");
      const receipts = task.decisions ??= [];
      const prior = receipts.find(d => d.requestId === requestId) ?? await this.archivedDecision(task, requestId);
      if (prior) {
        if (prior.text !== text) throw Error("Conflicting decision requestId reuse");
        return prior;
      }
      this.checkDecisionRevision(task, expectedRevision);
      if (expectedRevision !== undefined && (task.ownershipHold || task.recoveryEnrollment === "held-legacy" || task.diagnosticCode === "manual-pause" ||
          task.question && task.question.answer === undefined || task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now())) throw Error("Execution steering authority held or expired");
      if (receipts.length >= 32) throw Error("Execution decision limit reached; use plugin_dispatch_decisions consolidate for explicitly superseded applied steering, originals remain archived");
      const receipt: ExecutionDecision = { requestId, text, recordedAt: this.now(), state: "pending", revision: nextDecisionRevision(receipts) };
      if (decisionDataBytes([...receipts, receipt]) > 16000)
        throw Error("Execution decision data limit reached; use plugin_dispatch_decisions consolidate for explicitly superseded applied steering, originals remain archived");
      receipts.push(receipt);
      if (!task.token && !task.recoveryReason && !(task.question && task.question.answer === undefined) && wake?.(structuredClone(task))) {
        if (["blocked", "paused"].includes(task.status) && task.diagnosticCode !== "manual-pause") task.status = "ready";
        if (task.status === "ready") {
          delete task.assessmentRetryAt;
          if (task.workerRetry) task.workerRetry.nextAt = this.now();
        }
      }
      this.event(draft, task, "status", `Decision recorded: ${requestId}; pending strategy consumption`);
      return receipt;
    });
  }
  private decisionFile(task: Pick<Execution, "id" | "parent">, requestId: string): string {
    const scope = createHash("sha256").update(JSON.stringify([task.parent, task.id])).digest("hex");
    return path.join(path.dirname(this.file), "execution-decision-audit", scope, createHash("sha256").update(requestId).digest("hex") + ".json");
  }
  private async archivedDecision(task: Pick<Execution, "id" | "parent">, requestId: string): Promise<ExecutionDecision | undefined> {
    try {
      const record = JSON.parse(await readFile(this.decisionFile(task, requestId), "utf8"));
      if (record.executionId !== task.id || record.parent !== task.parent || record.decision?.requestId !== requestId ||
          !validDecisionInput(requestId, record.decision.text) || record.decision.state !== "applied") throw Error("Invalid archived decision binding");
      return record.decision;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  }
  /** Exact original text for authenticated parent inspection; never a replay or scope grant. */
  async readDecision(parent: string, id: string, requestId: string): Promise<ExecutionDecision | undefined> {
    if (/^(dispatch|subagent):/.test(parent) || !validDecisionInput(requestId, "audit")) throw Error("Invalid parent decision lookup");
    const task = this.list(parent).find(task => task.id === id);
    if (!task) throw Error("Execution not in this conversation");
    return task.decisions?.find(d => d.requestId === requestId) ?? this.archivedDecision(task, requestId);
  }
  /** Deliberate parent amendment, not automatic lossy compaction or silent eviction.
   * Originals are archived BEFORE the atomic active-window commit. Failed saves
   * leave the old window executable, and retries verify the same immutable audit. */
  consolidateDecisions(parent: string, id: string, requestId: string, text: string, replaces: readonly string[],
      wake?: (task: Readonly<Execution>) => boolean, followUp?: ExecutionFollowUp, expectedRevision?: number): Promise<ExecutionDecision> {
    return this.mutate(async draft => {
      if (/^(dispatch|subagent):/.test(parent)) throw Error("Nested worker decisions are disabled");
      if (!validDecisionInput(requestId, text) || (followUp !== undefined && !validExecutionFollowUp(followUp)) || !Array.isArray(replaces) || !replaces.length || replaces.length > 32 ||
          new Set(replaces).size !== replaces.length || replaces.some(old => !validDecisionInput(old, "audit") || old === requestId)) throw Error("Invalid decision consolidation");
      const task = this.find(draft, id);
      if (task.parent !== parent || task.parentStopped || ["completed", "cancelled"].includes(task.status)) throw Error("Execution cannot accept a decision in this conversation");
      const receipts = task.decisions ?? [];
      const prior = receipts.find(d => d.requestId === requestId) ?? await this.archivedDecision(task, requestId);
      if (prior) {
        if (prior.text !== text || JSON.stringify(prior.supersedes) !== JSON.stringify(replaces) || JSON.stringify(prior.followUp) !== JSON.stringify(followUp)) throw Error("Conflicting decision requestId reuse");
        return prior;
      }
      this.checkDecisionRevision(task, expectedRevision);
      if (expectedRevision !== undefined && (task.ownershipHold || task.recoveryEnrollment === "held-legacy" || task.diagnosticCode === "manual-pause" ||
          task.question && task.question.answer === undefined || task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now())) throw Error("Execution steering authority held or expired");
      const old = replaces.map(key => receipts.find(d => d.requestId === key));
      if (old.some(receipt => !receipt || receipt.state !== "applied")) throw Error("Only exact applied active decisions may be consolidated; pending steering must first be consumed");
      const receipt: ExecutionDecision = { requestId, text, recordedAt: this.now(), state: "pending", revision: nextDecisionRevision(receipts), supersedes: [...replaces], ...(followUp ? { followUp: structuredClone(followUp) } : {}) };
      const active = [...receipts.filter(d => !replaces.includes(d.requestId)), receipt];
      if (active.length > 32 || decisionDataBytes(active) > 16000) throw Error("Consolidated active decision window still exceeds its bounded budget");
      for (const original of old as ExecutionDecision[]) {
        const archived = await this.archivedDecision(task, original.requestId);
        if (archived && JSON.stringify(archived) !== JSON.stringify(original)) throw Error("Archived decision conflict");
        if (!archived) {
          const file = this.decisionFile(task, original.requestId); await mkdir(path.dirname(file), { recursive: true });
          await writeFileDurable(file, JSON.stringify({ executionId: task.id, parent: task.parent, decision: original }) + "\n");
        }
      }
      task.decisions = active;
      if (!task.token && !task.recoveryReason && !(task.question && task.question.answer === undefined) && wake?.(structuredClone(task))) {
        if (["blocked", "paused"].includes(task.status) && task.diagnosticCode !== "manual-pause") task.status = "ready";
        if (task.status === "ready") { delete task.assessmentRetryAt; if (task.workerRetry) task.workerRetry.nextAt = this.now(); }
      }
      this.event(draft, task, "status", `Decision consolidated: ${requestId}; ${old.length} originals archived, pending strategy consumption`);
      return receipt;
    });
  }
  private planHistoryFile(task: Pick<Execution, "parent" | "id">, head: string): string {
    if (!/^[a-f0-9]{64}$/.test(head)) throw Error("Invalid plan history hash");
    const scope = createHash("sha256").update(JSON.stringify([task.parent, task.id])).digest("hex");
    return path.join(path.dirname(this.file), "execution-plan-audit", scope, head + ".json");
  }
  /** A reference into this exact execution's immutable evidence, never authority. */
  planHistoryReference(parent: string, id: string, history: PlanHistoryRef): PlanHistoryRef & { file: string } {
    const task = this.list(parent).find(item => item.id === id);
    if (!task) throw Error("Execution not in this conversation");
    return { ...history, file: this.planHistoryFile(task, history.head) };
  }
  async readPlanHistory(parent: string, id: string, head: string): Promise<PlanHistorySegment & { reference: PlanHistoryRef }> {
    // Bind the archive to parent/id even after normal terminal-ledger compaction.
    // Caller identity is host-owned; neither component is used as a file path.
    const file = this.planHistoryFile({ parent, id }, head);
    if ((await stat(file)).size > 256 * 1024) throw Error("Oversized plan history segment");
    const text = await readFile(file, "utf8");
    if (createHash("sha256").update(text).digest("hex") !== head) throw Error("Plan history content mismatch");
    const record = JSON.parse(text);
    if (record.schema !== 1 || record.parent !== parent || record.executionId !== id || !Array.isArray(record.steps) || !record.steps.length ||
        record.completed !== (record.previous?.completed ?? 0) + record.steps.length || record.segments !== (record.previous?.segments ?? 0) + 1 ||
        record.maxStepId !== Math.max(record.previous?.maxStepId ?? -1, ...record.steps.map((entry: CompletedPlanStep) => entry.stepId))) throw Error("Invalid plan history binding");
    return { previous: record.previous, steps: record.steps, followUps: record.followUps,
      reference: { head, completed: record.completed, segments: record.segments, maxStepId: record.maxStepId } };
  }
  /** Archive exact independently completed steps before retiring their active slots.
   * The old active checkpoint remains intact if the subsequent checkpoint fails;
   * an orphan immutable blob is harmless and reused exactly on retry. */
  archiveCompletedPlan(id: string, token: string, segment: PlanHistorySegment, decisionRevision?: number): Promise<PlanHistoryRef> {
    return this.mutate(async draft => {
      const task = this.owned(draft, id, token); this.checkDecisionRevision(task, decisionRevision);
      if (task.parentStopped || task.ownershipHold || task.recoveryEnrollment === "held-legacy") throw Error("Completed plan archival requires current retained ownership");
      if (task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now()) throw new ExecutionDeadlineExpired();
      if (!Array.isArray(segment.steps) || !segment.steps.length || segment.steps.length > 6 || new Set(segment.steps.map(step => step.stepId)).size !== segment.steps.length ||
          segment.steps.some(step => !Number.isSafeInteger(step.stepId) || step.stepId < 0 || !validExecutionFollowUp(step.step) ||
            !step.outcome || typeof step.outcome.result !== "string" || step.outcome.result.length > 8000) ||
          !Array.isArray(segment.followUps) || segment.followUps.length > 6 || segment.followUps.some(id => !validDecisionInput(id, "audit"))) throw Error("Invalid completed plan segment");
      const saved = JSON.parse(task.checkpoint ?? "null");
      if (!saved || saved.v !== 1 || !Array.isArray(saved.plan) || !Array.isArray(saved.outcomes) || saved.outcomes.length !== segment.steps.length ||
          (saved.planHistory?.head ?? null) !== (segment.previous?.head ?? null) ||
          (saved.planHistory?.completed ?? 0) !== (segment.previous?.completed ?? 0) || (saved.planHistory?.segments ?? 0) !== (segment.previous?.segments ?? 0) ||
          (saved.planHistory?.maxStepId ?? -1) !== (segment.previous?.maxStepId ?? -1) || segment.steps.some((entry, index) =>
            entry.stepId !== (saved.stepIds?.[index] ?? index) || JSON.stringify(entry.step) !== JSON.stringify(saved.plan[index]) ||
            JSON.stringify(entry.outcome) !== JSON.stringify(saved.outcomes[index]))) throw Error("Completed archive does not match retained checkpoint");
      if (segment.previous) {
        const previous = await this.readPlanHistory(task.parent, task.id, segment.previous.head);
        if (previous.reference.completed !== segment.previous.completed || previous.reference.segments !== segment.previous.segments || previous.reference.maxStepId !== segment.previous.maxStepId) throw Error("Plan history chain mismatch");
      }
      const completed = (segment.previous?.completed ?? 0) + segment.steps.length, segments = (segment.previous?.segments ?? 0) + 1;
      if (!Number.isSafeInteger(completed) || !Number.isSafeInteger(segments)) throw Error("Plan history counter exhausted");
      const maxStepId = Math.max(segment.previous?.maxStepId ?? -1, ...segment.steps.map(entry => entry.stepId));
      const text = JSON.stringify({ schema: 1, executionId: task.id, parent: task.parent, ...segment, completed, segments, maxStepId }) + "\n";
      if (Buffer.byteLength(text) > 256 * 1024) throw Error("Completed plan segment exceeds archive budget");
      const head = createHash("sha256").update(text).digest("hex"), file = this.planHistoryFile(task, head);
      try { if (await readFile(file, "utf8") !== text) throw Error("Conflicting completed plan archive"); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await mkdir(path.dirname(file), { recursive: true }); await writeFileDurable(file, text);
      }
      return { head, completed, segments, maxStepId };
    });
  }
  /** Delivery receipt at an owned boundary; never a semantic approval. */
  applyDecisions(id: string, token: string): Promise<ExecutionDecision[]> {
    let changed = false;
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      for (const d of task.decisions ?? []) if (d.state === "pending") {
        changed = true;
        d.state = "applied"; d.appliedAt = this.now(); d.appliedClaim = createHash("sha256").update(token).digest("hex");
      }
      return task.decisions ?? [];
    }, () => changed);
  }
  private checkDecisionRevision(task: Execution, revision?: number): void {
    if (revision !== undefined && revision !== executionDecisionRevision(task.decisions))
      throw new ExecutionDecisionConflict("Parent decision arrived at execution boundary");
  }
  fenceDecisions(id: string, token: string, revision: number): Promise<void> {
    // A read-only fence still joins the writer queue and checks writability,
    // current ownership and revision AFTER preceding mutations have settled.
    // It creates no receipt or authority, so must not republish the full ledger.
    return this.mutate(draft => this.checkDecisionRevision(this.owned(draft, id, token), revision), () => false);
  }
  /** Only our own drained claim may yield; keep all evidence and intent. */
  deferDecision(id: string, token: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.owned(draft, id, token);
      task.status = "ready";
      delete task.token;
    });
  }
  answer(parent: string, id: string, questionId: string, text: string): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.parent !== parent || task.parentStopped || (task.intent && !task.question?.retainedAssessment) || task.status !== "paused" ||
          task.question?.id !== questionId || task.question.answer !== undefined) throw Error("Question no longer awaiting an answer");
      if (typeof text !== "string" || !text.trim() || text.length > 8000) throw Error("Invalid answer");
      task.question.answer = text;
      task.status = "ready";
      if (task.workerRetry) task.workerRetry.nextAt = this.now();
      this.event(draft, task, "status", "Antwort gespeichert; Ausführung bereit");
    });
  }
  complete(id: string, token: string, result: string, decisionRevision?: number): Promise<void> {
    return this.mutate(draft => {
      if (typeof result !== "string" || result.length > 64000) throw Error("Invalid execution result");
      const task = this.owned(draft, id, token);
      this.checkDecisionRevision(task, decisionRevision);
      if (task.intent) throw Error("Unresolved effect intent");
      task.status = "completed";
      delete task.assessmentHold;
      delete task.workerRetry;
      task.terminalAt = this.now();
      task.result = result;
      delete task.token;
      if (result.length === 0) {
        task.diagnosticCode = "empty-result";
        this.event(draft, task, "status", "empty-result: Worker abgeschlossen ohne Ergebnis-Text; leeres Ergebnis ist markiert, kein Fehler. Ergebnis prüfen und bei Bedarf neu einreichen oder explizit auflösen.");
      }
      this.event(draft, task, "result", result);
    });
  }
  /** One startup fence for all retained stops, not one full ledger clone per task. */
  cancelTasks(stops: readonly { parent: string; taskId: string; preexistingUnscoped?: readonly string[] }[]): Promise<void> {
    const scopes = new Map<string, typeof stops[number][]>();
    for (const stop of stops) {
      if (!stop.taskId.trim()) return Promise.reject(Error("Task identity required"));
      const rows = scopes.get(stop.parent) ?? []; rows.push(stop); scopes.set(stop.parent, rows);
    }
    const apply = (data: Ledger, write: boolean): boolean => {
      let changed = false;
      const revoked = new Set<string>();
      for (const task of data.executions) {
        const rows = scopes.get(task.parent); if (!rows) continue;
        if (task.dependency?.taskId && rows.some(row => row.taskId === task.dependency!.taskId)) {
          revoked.add(task.id);
          changed ||= task.parentStopped !== true || !["completed", "cancelled"].includes(task.status) || task.terminalAt == null || task.token !== undefined;
          if (write) { task.parentStopped = true; if (!["completed", "cancelled"].includes(task.status)) task.status = "cancelled"; task.terminalAt ??= this.now(); delete task.token; }
        } else if (!task.dependency?.taskId && task.status !== "cancelled" && rows.some(row => !row.preexistingUnscoped?.includes(task.id))) {
          changed ||= task.ownershipHold !== "unscoped-parent-stop" || task.status === "ready" || task.recoveryReason == null;
          if (write) { task.ownershipHold = "unscoped-parent-stop"; if (task.status === "ready") task.status = "blocked"; task.recoveryReason ??= "Legacy execution ancestry held after a task-scoped parent stop; inspect ownership before retrying."; }
        }
      }
      changed ||= data.events.some(event => revoked.has(event.executionId));
      if (write) data.events = data.events.filter(event => !revoked.has(event.executionId));
      return changed;
    };
    return this.mutate(data => { apply(data, true); }, undefined, data => !apply(data, false));
  }
  cancelTask(parent: string, taskId: string, preexistingUnscoped: readonly string[] = []): Promise<void> {
    if (!taskId.trim()) return Promise.reject(Error("Task identity required"));
    return this.cancelParent(parent, taskId, preexistingUnscoped);
  }
  cancelParent(parent: string, taskId?: string, preexistingUnscoped: readonly string[] = []): Promise<void> {
    let changed = false;
    return this.mutate(draft => {
      const revoked = new Set<string>();
      for (const task of draft.executions) {
        if (task.parent !== parent) continue;
        if (taskId !== undefined && !task.dependency?.taskId && !preexistingUnscoped.includes(task.id) && task.status !== "cancelled") {
          changed ||= task.ownershipHold !== "unscoped-parent-stop" || task.status === "ready" || task.recoveryReason == null;
          task.ownershipHold = "unscoped-parent-stop";
          if (task.status === "ready") task.status = "blocked";
          task.recoveryReason ??= "Legacy execution ancestry held after a task-scoped parent stop; inspect ownership before retrying.";
          continue;
        }
        if (taskId !== undefined && task.dependency?.taskId !== taskId) continue;
        revoked.add(task.id);
        changed ||= task.parentStopped !== true || !["completed", "cancelled"].includes(task.status) ||
          task.terminalAt == null || task.token !== undefined;
        task.parentStopped = true;
        if (!["completed", "cancelled"].includes(task.status)) task.status = "cancelled";
        task.terminalAt ??= this.now();
        delete task.token;
      }
      const remaining = draft.events.filter(event => taskId === undefined ? event.parent !== parent : !revoked.has(event.executionId));
      changed ||= remaining.length !== draft.events.length;
      draft.events = remaining;
    }, () => changed);
  }
  /** Token fencing prevents a late failure from pausing a replacement claim. */
  fail(id: string, token: string, code: ExecutionDiagnosticCode,
    recovery?: { strategy: RecoveryStrategy; policy?: ExecutionRecoveryPolicy; assessmentHold?: Execution["assessmentHold"] }): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.status !== "running" || task.token !== token) return;
      task.status = task.intent ? "blocked" : "paused";
      const priorHold = task.assessmentHold;
      task.assessmentHold = recovery?.assessmentHold;
      task.diagnosticCode = code;
      if (!["runtime-failure", "worker-failed"].includes(code)) delete task.workerRetry;
      if (code === "worker-failed" || code === "worker-cancelled") task.recoverySession = `dispatch:${task.id}:${token}`;
      else task.recoverySession ??= `dispatch:${task.id}:${token}`;
      delete task.token;
      if (task.assessmentHold) {
        task.diagnosticCode = task.assessmentHold.state === "waiting" ? "assessment-waiting" : "assessment-blocked";
        delete task.workerRetry;
      }
      if (task.assessmentHold || code === "assessment-stalled") delete task.assessmentRetryAt;
      const scheduled = recovery && !task.assessmentHold && this.scheduleWorkerRetry(task, recovery.strategy, recovery.policy);
      if (code === "assessment-stalled" && task.status === "blocked" && task.intent && task.question?.retainedAssessment && task.question.answer !== undefined && !task.assessmentStalledEventId) {
        this.event(draft, task, "assessment-stalled", "Retained assessment needs parent attention");
      }
      this.event(draft, task, "status", scheduled
        ? "Interne Ausführungsunterbrechung; automatischer Wiederanlauf nach Backoff, keine Nutzeraktion erforderlich."
        : task.assessmentHold ? "Aufgabe wartet auf eine externe Voraussetzung. Ohne neue Informationen keine weiteren automatischen Prüfungen; bisherige Ergebnisse bleiben erhalten."
        : code === "assessment-stalled" ? message(resolveLanguage({}, { kind: "conversation", language: task.dependency?.anchor?.language }), "dispatcher.assessmentStalled")
        : code === "deadline-expired" ? `${task.status}: deadline-expired`
        : task.diagnosticCode === "retry-exhausted" ? `${task.status}: retry-exhausted; automatische Wiederanläufe beendet nach ${this.workerRecoveryLimit()} Versuchen. Manuelle Intervention erforderlich: Aufgabe explizit fortsetzen oder abbrechen.`
        : task.status,
        !!task.assessmentHold && (priorHold?.state !== task.assessmentHold.state || priorHold?.step !== task.assessmentHold.step));
    });
  }
  /** Host-only recovery of a failed worker. Preserve intent and transcript;
   * the matching strategy must reconcile uncertain effects in a new worker claim.
   * Manual pauses, semantic blockers, questions and expired authority never qualify.
   */
  retryWorker(id: string, strategy: RecoveryStrategy, policy?: ExecutionRecoveryPolicy): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (this.parentOwnsTask(task, draft.turns)) return;
      const reason = task.recoveryReason;
      if (this.scheduleWorkerRetry(task, strategy, policy, false))
        this.event(draft, task, "status", "Interne Pause mit dauerhaftem automatischem Wiederanlauf und Backoff; keine Nutzeraktion erforderlich.");
      else if (task.diagnosticCode === "retry-exhausted")
        this.event(draft, task, "status", "retry-exhausted: automatisches Retry-Budget erschöpft; manuelle Intervention erforderlich: Aufgabe explizit fortsetzen oder abbrechen.");
      else if (task.recoveryReason && task.recoveryReason !== reason)
        this.event(draft, task, "status", task.diagnosticCode === "deadline-expired"
          ? "Auftragsfrist abgelaufen; automatische Wiederaufnahme beendet."
          : "Automatische Wiederaufnahme durch konfigurierte Recovery-Regel verhindert; gespeicherte Ursache prüfen.");
    });
  }
  private scheduleWorkerRetry(task: Execution, strategy: RecoveryStrategy, policy?: ExecutionRecoveryPolicy, newFailure = true): boolean {
    if (task.assessmentHold || task.recoveryEnrollment === "held-legacy" || !["blocked", "paused", "ready"].includes(task.status) ||
        !["worker-failed", "runtime-failure"].includes(task.diagnosticCode ?? "") ||
        task.parentStopped || task.question && !task.question.answer) return false;
    if (task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now()) {
      task.status = task.intent ? "blocked" : "paused";
      task.diagnosticCode = "deadline-expired";
      task.recoveryReason = "Execution mandate deadline expired; no automatic work is authorized.";
      delete task.workerRetry;
      return false;
    }
    if (task.classifierReceipt !== undefined && !["observed", "abandoned"].includes(task.classifierReceipt.phase) &&
        !this.canAbandonClassifier(task, strategy)) {
      task.status = task.intent ? "blocked" : "paused";
      task.recoveryReason = "Classifier HTTP outcome unknown; retained receipt forbids automatic replay.";
      delete task.workerRetry;
      return false;
    }
    if (!strategy.reconcile) {
      if (task.workerRetry) {
        task.status = task.intent ? "blocked" : "paused";
        task.recoveryReason = "Matching strategy no longer supports reconciliation; automatic work held.";
        delete task.workerRetry;
      }
      return false;
    }
    const reason = recoveryBlock(task, strategy, policy);
    if (reason) { task.status = task.intent ? "blocked" : "paused"; task.recoveryReason = reason; delete task.workerRetry; return false; }
    if (this.canAbandonClassifier(task, strategy)) task.classifierReceipt = { ...task.classifierReceipt!, phase: "abandoned" };
    delete task.recoveryReason;
    if (!newFailure && task.workerRetry) {
      if (task.workerRetry.nextAt > this.now()) return false;
      if (task.status === "ready") return false; // eligible ready retry may now be claimed
      task.status = "ready";
      return true;
    }
    const prior = task.workerRetry?.attempts ?? 0;
    // Cap bounds total worker attempts (initial run + retries): once the next
    // attempt would exceed the budget, hold the task for manual intervention.
    if (prior + 1 >= this.workerRecoveryLimit()) {
      task.status = task.intent ? "blocked" : "paused";
      task.diagnosticCode = "retry-exhausted";
      delete task.workerRetry;
      return false;
    }
    const attempts = prior + 1;
    task.workerRetry = { attempts, nextAt: this.now() + Math.min(300000, 15000 * 2 ** Math.min(attempts - 1, 5)) };
    // Runtime/validator holds stay observable during backoff, but unlike manual
    // pauses have a durable wake-up owner. Worker transport retries keep ready.
    task.status = task.diagnosticCode === "runtime-failure" ? (task.intent ? "blocked" : "paused") : "ready";
    return true;
  }
  control(id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (["completed", "cancelled"].includes(task.status)) return;
      task.controlRevision = (task.controlRevision ?? 0) + 1;
      if (!Number.isSafeInteger(task.controlRevision)) throw Error("Execution control revision exhausted");
      if (action === "resume") {
        if (task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now()) throw new ExecutionDeadlineExpired();
        if (task.status !== "paused" || task.intent || (task.question && task.question.answer === undefined)) throw Error("Execution cannot resume without resolving its blocker");
        task.recoveryEnrollment = "current";
        task.status = "ready";
        if (task.workerRetry) task.workerRetry.nextAt = this.now();
        delete task.diagnosticCode;
      } else if (action === "pause") {
        // Pause is not a blocker-resolution API. Revoking an in-flight effect
        // leaves its outcome ambiguous, even before startup recovery runs.
        // An existing blocker retains its effects; explicit pause adds a hold.
        if (task.status !== "blocked") task.status = task.intent ? "blocked" : "paused";
        task.diagnosticCode = "manual-pause";
        delete task.assessmentHold;
        delete task.workerRetry;
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
        // Older versions acknowledged question events after showing them to the
        // channel, without ever delivering them to Main. Reconstitute one stable
        // receipt from the persisted question, not a new worker execution.
        const question = task.question;
        if (enabled(task) && task.status === "paused" && question && question.answer === undefined &&
            (!task.intent || question.retainedAssessment === true) && !task.parentStopped && !task.ownershipHold &&
            task.recoveryEnrollment === "current" && task.diagnosticCode !== "manual-pause" &&
            this.executionTaskAllowed(task) && (task.dependency?.expiresAt === undefined || task.dependency.expiresAt > this.now()) &&
            !question.eventId && !draft.events.some(event => event.executionId === task.id && event.type === "question")) {
          this.event(draft, task, "question", `Question ${question.id}: ${question.text}`);
        }
        // Reconstruct one durable parent notice for the historical retry-loop
        // signature. No claim, assessment, effect or authorization is changed.
        if (enabled(task) && task.status === "blocked" && ["retry-exhausted", "assessment-stalled"].includes(task.diagnosticCode ?? "") &&
            task.question?.retainedAssessment && task.question.answer !== undefined && task.intent &&
            (!task.assessmentStalledEventId || task.assessmentStalledQuestionId !== undefined && task.assessmentStalledQuestionId !== task.question.id) &&
            !task.parentStopped && !task.ownershipHold && task.recoveryEnrollment === "current" && this.executionTaskAllowed(task) &&
            (task.dependency?.expiresAt === undefined || task.dependency.expiresAt > this.now())) {
          this.event(draft, task, "assessment-stalled", "Retained assessment needs parent attention");
        }
        // Older cores enrolled semantic holds into the transport retry budget.
        // Preserve their evidence without waking them or replaying effects.
        if (enabled(task) && task.assessmentHold && !task.parentStopped && !task.ownershipHold &&
            task.recoveryEnrollment === "current" && ["ready", "paused", "blocked"].includes(task.status) &&
            ["runtime-failure", "retry-exhausted"].includes(task.diagnosticCode ?? "")) {
          task.status = task.intent ? "blocked" : "paused";
          task.diagnosticCode = task.assessmentHold.state === "waiting" ? "assessment-waiting" : "assessment-blocked";
          delete task.workerRetry;
          delete task.assessmentRetryAt;
        }
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
          : task.classifierReceipt && !["observed", "abandoned"].includes(task.classifierReceipt.phase) &&
              !(strategy && this.canAbandonClassifier(task, strategy))
            ? "Classifier HTTP outcome unknown; retained receipt forbids automatic replay."
            : recoveryBlock(task, strategy, policy);
        if (reason) {
          task.recoveryReason = reason;
          delete task.workerRetry;
          task.status = "blocked";
          this.event(draft, task, "status", reason);
        } else {
          if (strategy && this.canAbandonClassifier(task, strategy)) task.classifierReceipt = { ...task.classifierReceipt!, phase: "abandoned" };
          task.status = "ready"; delete task.recoveryReason;
          // Only a current, enabled mandate with no stop, expiry, manual pause or
          // approval question may refresh its read-only assessment policy. This
          // is atomic with claim reconstruction, never a second ledger writer.
          if (task.recoveryEnrollment === "current" && !task.parentStopped && !task.question &&
              task.diagnosticCode !== "manual-pause" &&
              (task.dependency?.expiresAt === undefined || task.dependency.expiresAt > this.now())) {
            const refresh = strategy?.refreshAssessment?.(structuredClone(task), this.now());
            if (refresh) {
              if (typeof refresh.checkpoint !== "string" || refresh.checkpoint.length > 64000 ||
                  typeof refresh.reason !== "string" || !refresh.reason || refresh.reason.length > 8000) throw Error("Invalid assessment policy refresh");
              task.checkpoint = refresh.checkpoint;
              task.assessmentRetryAt = this.now();
              if (task.workerRetry) task.workerRetry.nextAt = this.now();
              this.event(draft, task, "status", refresh.reason);
            }
          }
        }
      }
      // Dispatcher inboxes never replay independently; after claim recovery
      // their orphan turn records carry no additional execution authority.
      draft.turns = draft.turns?.filter(turn => !turn.sessionKey.startsWith("dispatch:") ||
        draft.executions.some(task => task.token && task.intent && turn.sessionKey === `dispatch:${task.id}:${task.token}`));
    });
  }
  /** Explicit acknowledgement retains ambiguous intent and audit history. No budget reset. */
  continueReconciled(parent: string, id: string, requestId: string, executionHash: string, evidence: string, fingerprint: string,
    eligible: (task: Readonly<Execution>) => void, resumePaused = false): Promise<void> {
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.parent !== parent || /^(dispatch|subagent):/.test(parent)) throw Error("Parent execution ownership required");
      if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(requestId) || !/^[a-f0-9]{64}$/.test(executionHash) || !/^[a-f0-9]{64}$/.test(fingerprint) || !evidence.trim() || evidence.length > 8000) throw Error("Bounded reconciliation identity and evidence required");
      const prior = task.parentContinuation;
      if (prior?.requestId === requestId) {
        if (prior.executionHash !== executionHash || prior.evidence !== evidence || prior.fingerprint !== fingerprint || !!prior.resumedManualPause !== resumePaused) throw Error("Continuation identity conflict");
        return;
      }
      if (executionRecoveryHash(task) !== executionHash) throw Error("Execution changed; inspect fresh evidence");
      if (!["blocked", "paused"].includes(task.status) || task.token || task.parentStopped || task.ownershipHold ||
          task.recoveryEnrollment === "held-legacy" || task.diagnosticCode === "manual-pause" && !resumePaused || task.recoveryGrant ||
          task.question && task.question.answer === undefined || task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now()) throw Error("Execution authority remains held");
      if (resumePaused && task.diagnosticCode !== "manual-pause") throw Error("No exact manual pause to resume");
      eligible(structuredClone(task));
      // Preserve intent, worker session, checkpoint, counters and all policy gates.
      // In particular do NOT use resolve()'s policy-bypassing recoveryGrant.
      task.parentContinuation = { requestId, executionHash, evidence, fingerprint, ...(resumePaused ? { resumedManualPause: true } : {}), at: this.now() };
      delete task.assessmentStalledEventId;
      if (resumePaused) delete task.diagnosticCode;
      (task.resolutions ??= []).push({ actor: parent, action: "continue", evidence, at: this.now() });
      task.status = "ready";
      delete task.recoveryReason;
      this.event(draft, task, "status", "Parent reconciled retained evidence; continue same execution without replay grant or budget reset");
    });
  }

  resolve(parent: string, id: string, actor: string, action: "continue" | "retry", evidence: string): Promise<void> {
    if (!actor.trim() || !evidence.trim() || evidence.length > 8000) return Promise.reject(Error("Actor and bounded evidence required"));
    return this.mutate(draft => {
      const task = this.find(draft, id);
      if (task.parent !== parent || task.parentStopped || !["blocked", "paused"].includes(task.status) || (task.question && task.question.answer === undefined)) throw Error("Execution cannot be resolved");
      if (!task.recoverySession && task.token && task.intent) task.recoverySession = `dispatch:${task.id}:${task.token}`;
      delete task.token;
      (task.resolutions ??= []).push({ actor, action, evidence, at: this.now() });
      task.recoveryEnrollment = "current";
      task.recoveryGrant = { action, restarts: task.restarts };
      delete task.recoveryReason;
      task.status = "ready";
      if (task.workerRetry) task.workerRetry.nextAt = this.now();
      this.event(draft, task, "status", `${actor}: ${action}; uncertain effects may duplicate. Evidence: ${evidence}`);
    });
  }
  /** Explicit native owner recovery of a structurally contradictory terminal
   * report, never automatic replay or reopening an honest completion. Original
   * terminal receipt is immutable before the active state changes. */
  reopenContradictoryCompletion(parent: string, id: string, requestId: string, text: string, checkpointHash: string, expectedRevision: number): Promise<Execution> {
    return this.mutate(async draft => {
      const task = this.find(draft, id);
      if (task.parent !== parent || /^(dispatch|subagent):/.test(parent) || !validDecisionInput(requestId, text) || !/^[a-f0-9]{64}$/.test(checkpointHash)) throw Error("Invalid exact owner reconciliation");
      const prior = task.contradictoryCompletionReopen;
      if (prior?.requestId === requestId) {
        if (prior.text !== text || prior.checkpointHash !== checkpointHash) throw Error("Reopen identity conflict");
        return structuredClone(task);
      }
      this.checkDecisionRevision(task, expectedRevision);
      if (task.status !== "completed" || draft.events.some(event => event.executionId === id && event.type === "result") || task.token || task.intent || task.parentStopped || task.ownershipHold || task.recoveryEnrollment === "held-legacy" || task.question ||
          task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= this.now() || task.strategy !== "sequential" || task.strategyVersion !== 1 || !task.checkpoint || !task.recoverySession ||
          createHash("sha256").update(task.checkpoint).digest("hex") !== checkpointHash) throw Error("Terminal reconciliation not eligible");
      const saved = JSON.parse(task.checkpoint);
      if (!Array.isArray(saved.plan) || !Array.isArray(saved.outcomes) || !saved.outcomes.length || saved.plan.length !== saved.outcomes.length) throw Error("Not an exact terminal step boundary");
      const last = saved.outcomes.at(-1);
      if (!last || typeof last.result !== "string" || !/\nSTEP-STATUS:\s*blocked:\s*[^\n]+\s*$/i.test(last.result) || !last.requested?.model) throw Error("No retained contradictory blocked terminal report");
      const key = task.settledEffect?.key;
      if (!key) throw Error("Missing retained settled effect identity");
      const scope = createHash("sha256").update(JSON.stringify([parent, id])).digest("hex");
      const directory = path.join(path.dirname(this.file), "execution-reopen-audit", scope); await mkdir(directory, { recursive: true });
      const audit = path.join(directory, createHash("sha256").update(requestId).digest("hex") + ".json");
      const original = { parent, executionId: id, requestId, text, checkpointHash, original: task };
      try { if (await readFile(audit, "utf8") !== JSON.stringify(original) + "\n") throw Error("Reopen archive conflict"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; await writeFileDurable(audit, JSON.stringify(original) + "\n"); }
      saved.outcomes.pop();
      saved.assessment = { index: saved.outcomes.length, reply: last.result, route: last.requested, session: task.recoverySession,
        tools: 0, effectsUnknown: true, reopenedReviewOnly: true, evidence: [], attempts: 0, decisionRevision: expectedRevision };
      delete saved.correction; delete saved.progress; delete saved.prior; delete saved.readyAdmission;
      const checkpoint = JSON.stringify(saved); if (checkpoint.length > 64000) throw Error("Reopened evidence cannot fit without authority loss");
      task.checkpoint = checkpoint; task.status = "ready"; delete task.result; delete task.terminalAt;
      task.recoveryEnrollment = "current"; task.assessmentRetryAt = this.now();
      if (task.workerRetry) task.workerRetry.nextAt = this.now();
      task.contradictoryCompletionReopen = { requestId, text, checkpointHash, at: this.now() };
      this.event(draft, task, "status", "Operator reopened contradictory completion: retained final worker report still says blocked. Original terminal receipt archived; read-only reassessment only, no effect replay or new writer.");
      return structuredClone(task);
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

function validDecisionInput(requestId: unknown, text: unknown): boolean {
  return typeof requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(requestId) &&
    typeof text === "string" && !!text.trim() && Buffer.byteLength(text, "utf8") <= 4000;
}

function validAddress(value: unknown): value is import("./types.js").Address {
  const a = value as import("./types.js").Address;
  return !!a && typeof a === "object" && typeof a.channel === "string" && !!a.channel && typeof a.target === "string" && !!a.target &&
    (a.thread === undefined || typeof a.thread === "string") && Object.keys(a).every(k => ["channel", "target", "thread"].includes(k));
}

/** Delivery target of an execution: task anchor, else submitting turn's origin, else configured home. Never another session's address. */
export function executionTarget(task: Pick<Execution, "dependency" | "origin"> | undefined, home: import("./types.js").Address | undefined): import("./types.js").Address | undefined {
  return task?.dependency?.anchor?.replyTo ?? task?.origin ?? home;
}
