/** Durable task and session data contracts; behavior remains in Harness. */
import type { TaskRef } from "./task-lifecycle.js";
import type { TaskPriority } from "./task-priority.js";
import type { RepetitionBudget } from "./repetition-budget.js";
import type { OperatorBudgetGrant } from "./natural-budget-reset.js";
import type { CronCheckpoint } from "./cron-checkpoint.js";
import type { Address, Inbound, RuntimeSession } from "./types.js";
import type { OutboxEntry } from "./delivery/outbox.js";

export interface PendingApproval {
  id: string;
  sessionKey: string;
  tool: string;
  input: unknown;
  resolve: (ok: boolean) => void;
}

export interface Recurring {
  /** Persistent identity: exact owner-control authorization and recurring single-flight ownership.
   * Legacy schedules acquire one before their next tick. */
  sourceId?: string;
  prompt: string;
  everyMs: number;
  nextAt: number;
  paused: boolean;
  /** /loop --times N */
  remaining?: number;
}

export interface Goal {
  text: string;
  criteria: string[];
  paused: boolean;
  turns: number;
}

export interface DurableTask {
  /** Agent-wide operator authority; this record is technical state only. */
  taskRef?: TaskRef;
  /** Host-only recovery enrollment. Missing on pre-boundary history; models cannot enroll it. */
  recoveryEnrollment?: "current" | "held-legacy";
  /** Original checkpoint retained when automatic execution is held. */
  recoveryHeldState?: DurableTask["state"];
  /** Host read-only evidence epoch; not an execution grant or budget reset. */
  recoveryTranscriptFingerprint?: string;
  id: string;
  original: string;
  /** Explicit operator preference, retained independently of model context. */
  priority?: TaskPriority;
  state: "active" | "waiting" | "blocked" | "completed" | "stopped";
  next?: string;
  contextPreparation?: "compact" | "handover";
  depth: number;
  repetition?: RepetitionBudget;
  expiresAt?: number;
  anchor?: Inbound["completionAnchor"];
  /** Cron occurrence context; unfinished occurrences reopen this exact transcript. */
  runtimeSessionId?: string;
  /** Host-configured source identity inherited by occurrence continuations. */
  cronScope?: string;
  /** Exact host recurring source/configuration owning this unfinished mandate. */
  recurringSource?: string;
  /** Compare-and-set basis prevents an old unfinished occurrence replacing newer work. */
  cronCheckpointRevision?: number;
  /** Bounded result capsule only; full transcript/effect evidence stays retained. */
  cronComparison?: string;
  /** First-prompt comparison retained across pre-prompt yields/restart. */
  priorCronComparison?: { taskId: string; result: string };
  /** Settled answer for this task, never a neighbouring conversation turn. */
  lastReply?: string;
  /** Closed host receipt only: no provider output, prompt, or tool payloads. */
  supervisorDecision?: { proposal?: "continue" | "waiting" | "blocked" | "completed";
    verdict: "continue" | "waiting" | "blocked" | "completed" | "unresolved";
    /** Bounded independent verification after a silent terminal result. */
    silentCompletionRecheck?: "admitted" | "exhausted";
    diagnostic?: import("./completion-check.js").CompletionDiagnostic;
    detail?: import("./validator.js").CompletionFailureDetail;
    /** Host reason for a non-decision, not a semantic denial or execution permit. */
    deferred?: "queued-input" | "interrupted" | "paused" | "stopping" | "unavailable" | "no-verdict";
    /** One-shot assessment receipt. Only recoveryAdmission grants execution. */
    dependencyHold?: { evidence: string; parentDepth?: number; reason: "assessment-claimed" | "global-hold" | "independent-next-proposed";
      next?: string } };
  /** Bounded untrusted task evidence, persisted independently of recent chat. */
  completionObservations?: import("./session-archive.js").ArchiveEntry[];
  /** Persisted host admission; inference dedup is not an execution permit. */
  recoveryAdmission?: { id: string; depth: number; next: string; original: string; expiresAt?: number;
    /** Scheduler permission for this parent step only, never worker replay authority. */
    independent?: { evidence: string; taskId: string; sessionKey: string } };
  recoveryAttentionId?: string;
  /** Delivered blocker for children without task provenance (shared per session snapshot). */
  dependencyAttentionId?: string;
  /** Host-captured at task creation: unfinished executions without task provenance
   * that already existed, so they cannot be this task's children. Not effect evidence:
   * they stay fenced, reported and unchanged; later unscoped children still block. */
  preexistingUnscoped?: string[];
  /** Persist before inference; legacy claims without retry metadata remain fail-closed. */
  recoveryAssessment?: "claimed" | "decided";
  recoveryPolicyStamp?: string;
  /** Consecutive unusable assessments, including an in-flight crash reservation.
   * Used only for persisted backoff, never as a total attempt/authority limit. */
  recoveryRetry?: { attempts: number; nextAt: number; diagnostic?: import("./completion-check.js").CompletionDiagnostic;
    detail?: import("./validator.js").CompletionFailureDetail };
  wait?: { reason: string; nextAt: number; deadline: number };
  /** Monotonic scheduler claims, independent of productive follow-up depth. */
  waitChecks?: number;
  lastWait?: DurableTask["wait"];
  termination?: "deadline_expired" | "productive_budget_exhausted" | "malformed_checkpoint" | "recovery_assessment_failed" | "operator_budget_reset";
  /** Stable durable outbox notice; never renews the task's authority or budget. */
  budgetAttentionId?: string;
  /** API run window end, fixed when the API task was accepted; never renewed. */
  apiRunDeadline?: number;
  /** API run answer held while the task's delegated work is live (bounded by apiRunDeadline). */
  apiHold?: { deadline: number; entry: OutboxEntry };
  /** Answers of a newer run that arrived while the held run was fenced/releasing; flushed after it. */
  apiDeferred?: OutboxEntry[];
  /** Window-close revocation pending (persisted fence): no terminal result until it succeeded. */
  apiRevoking?: boolean;
  /** API run whose window close is pending (kept alive across restart even without an answer). */
  apiRevokingRun?: string;
  /** A stop of this run is part of the pending fence: every retry (also after restart) resumes
   * the complete stop (turn + follow-ups + children) before the fence can lift. */
  apiStop?: { id: string; text: string; taskId: string; executionTurnId?: string; replyTo?: { channel: string; target: string } };
  /** Tasks this API run's turn was bound to before a rebinding: their work stays owned by the run. */
  apiOwnedTasks?: string[];
  /** Queue namespace after reset; accepted IDs are never erased. */
  budgetEpoch?: string;
  explicitBlocked?: boolean;
  budgetReceipts?: Array<{ request: string; action: "reset" | "resume" | "reset-resume"; actor: string; at: number;
    expected: string; before: { depth: number; repetition?: RepetitionBudget; recoveryRetry?: DurableTask["recoveryRetry"];
      recoveryAssessment?: DurableTask["recoveryAssessment"]; recoveryAttentionId?: string;
      budgetAttentionId?: string; termination?: string; state: DurableTask["state"] } }>;
}

/** Content-free owner-process inspection; not an authorization or transcript API. */
export interface SessionObservation {
  running: boolean;
  prompting: boolean;
  queued: number;
  paused: boolean;
  tasks: Record<DurableTask["state"], number>;
}

export interface SessionState {
  key: string;
  task?: DurableTask;
  /** Retained mandates, independent of the most recent channel message. */
  tasks?: DurableTask[];
  /** Historical generated inbox entries retained by the upgrade boundary, never pumped. */
  heldRecoveryInputs?: Inbound[];
  completionRecent?: NonNullable<Inbound["completionContext"]>["recent"];
  statusDelivered?: Record<string, string>;
  hashtags?: import("./hashtags.js").HashtagReference[];
  operatorBudgetGrants?: OperatorBudgetGrant[];
  session?: RuntimeSession;
  opening?: Promise<RuntimeSession>;
  queue: Inbound[];
  running: boolean;
  replyTo?: Address;
  heartbeat?: Recurring;
  heartbeatDisabled?: boolean;
  /** Interrupted stop must finish child revocation before startup admission. */
  stopPending?: boolean;
  resetPending?: boolean;
  resetSources?: string[];
  sourceOwner?: string;
  cronCheckpoint?: CronCheckpoint;
  loop?: Recurring;
  goal?: Goal;
  /** Last user/channel input (for /retry). */
  lastInput?: Inbound;
  /** Input of the turn currently running. */
  current?: Inbound;
  /** The runtime prompt itself is in progress (narrower than `current`). */
  prompting?: boolean;
  /** The running turn was cancelled on request (API stop): finish it as cancelled. */
  cancelling?: Inbound;
  /** The turn whose runtime prompt already returned (too late to cancel). */
  prompted?: Inbound;
  /** Inputs steered into the running turn; durable until that turn completes. */
  steered?: Inbound[];
  /** Turn finished but its inbox→outbox transition is not yet saved. */
  unsaved?: boolean;
  /** Finished replies not yet delivered (persisted; retried without re-running the turn). */
  outbox: OutboxEntry[];
  lastActivity: number;
}
