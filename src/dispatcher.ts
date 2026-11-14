import { recoveryBlock, type ExecutionRecoveryPolicy } from "./execution-recovery.js";
import { validateWorkerPin } from "./model-roles.js";
import { executionDecisionRevision, ExecutionClaimConflict, ExecutionDecisionConflict, ExecutionDeadlineExpired, ExecutionWorkerFailure, ExecutionAssessmentHold, ExecutionAssessmentStalled, type Execution, type ExecutionEvent, type ExecutionStore } from "./execution.js";
import { toolGuardDenialReason } from "./tool-guard-error.js";
import { PriorityScheduler, type TaskPriority } from "./task-priority.js";

export interface DispatchContext {
  readonly signal: AbortSignal;
  checkpoint(value: string, notice?: { key: string; text: string }, decisionRevision?: number): Promise<void>;
  archiveCompletedPlan?(segment: import("./execution.js").PlanHistorySegment, decisionRevision: number): Promise<import("./execution.js").PlanHistoryRef>;
  /** Release the slot until a persisted assessment retry is due. No worker replay. */
  deferAssessment?(nextAt: number): Promise<never>;
  workerSession?(key: string): Promise<void>;
  /** Yield a settled step to another ready execution without replaying work. */
  yieldStep?(): Promise<void>;
  /** Optional only for source compatibility with existing strategy test adapters. */
  status?(text: string): Promise<void>;
  /** Persists a question and suspends this execution; never returns normally. */
  question?(text: string): Promise<never>;
  intent(key: string, replay: "safe" | "unsafe", route?: import("./model-roles.js").ModelPair, decisionRevision?: number): Promise<void>;
  settleIntent(key: string, result: string, checkpoint: string, decisionRevision?: number): Promise<void>;
  /** Authenticated parent data, not authority expansion or verdict override. */
  decisions?(): Promise<import("./execution.js").ExecutionDecision[]>;
  fenceDecisions?(revision: number): Promise<void>;
}
/** Trusted plugins supply policy; no model-generated field grants replay permission. */
export interface DispatcherStrategy {
  name: string;
  version: number;
  replaySafe: boolean;
  reconcile?: boolean;
  /** Trusted strategy preparation, persisted before an opaque worker intent. */
  prepareWorker?(task: Readonly<Execution>): Promise<void>;
  refreshAssessment?: import("./execution-recovery.js").RecoveryStrategy["refreshAssessment"];
  /** Trusted strategy opt-in; true only at a retained assessment boundary safe to wake. */
  decisionBoundary?(task: Readonly<Execution>): boolean;
  execute(task: Readonly<Execution>, context: DispatchContext): Promise<string>;
}

/** Parent revocation belongs to persistence even when scheduling is disabled. */
export async function stopDispatcherParent(store: ExecutionStore, parent: string, dispatcher?: Dispatcher): Promise<void> {
  if (dispatcher) {
    await dispatcher.cancelParent(parent);
    await Promise.all(store.list(parent).map(task => dispatcher.drainRevokedExecution(task.id)));
  } else await store.cancelParent(parent);
}

/** Event-driven host scheduler. Number of durable tasks is independent of active
 * capacity. A paused worker retains its slot until it actually settles. */
export class Dispatcher {
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private scheduling?: Promise<void>;
  private scheduleRequested = false;
  private readonly priorities = new PriorityScheduler();
  private delivering?: Promise<void>;
  private stopped = false;
  private initialized = false;
  private recovered = false;
  private submitting = 0;
  constructor(
    readonly store: ExecutionStore,
    private readonly strategy: DispatcherStrategy,
    private readonly capacity: number,
    private readonly deliver: (event: ExecutionEvent) => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly checkpoint?: (parent: string) => Execution["dependency"],
    private readonly recoveryPolicy?: ExecutionRecoveryPolicy,
    private readonly admissionFenced: () => boolean = () => false,
    /** Trusted strategies that only continue existing tasks after a strategy switch; new work uses `strategy`. */
    retained: readonly DispatcherStrategy[] = [],
    private readonly parentEnabled: (parent: string) => boolean = () => true,
    private readonly parallelAdmission?: import("./parallel-admission.js").ParallelAdmission,
    /** Host-captured address of the parent's current turn; persisted so results return to the requesting room. */
    private readonly origin?: (parent: string) => Execution["origin"],
    /** Live parent metadata, never supplied by workers; undefined means normal. */
    private readonly parentPriority?: (task: Execution) => TaskPriority | undefined,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid dispatcher capacity");
    for (const item of [strategy, ...retained])
      if (!item.name.trim() || !Number.isSafeInteger(item.version) || item.version < 1) throw Error("Invalid dispatcher strategy");
    for (const item of retained) if (item.name !== strategy.name) this.strategies.set(item.name, item);
    this.strategies.set(strategy.name, strategy);
  }
  private readonly strategies = new Map<string, DispatcherStrategy>();
  private strategyFor(task: Execution): DispatcherStrategy | undefined {
    const strategy = this.strategies.get(task.strategy);
    return strategy?.version === task.strategyVersion ? strategy : undefined;
  }
  get ready(): boolean { return this.recovered && !this.stopped; }
  /** Instance-wide worker occupancy; scheduler/submission and Main have no worker slot. */
  get workers(): { capacity: number; active: number; queued: number } {
    return { capacity: this.capacity, active: this.active.size,
      queued: this.store.list().filter(task => task.status === "ready" && !this.active.has(task.id) && this.parentEnabled(task.parent)).length };
  }
  /** Includes durable runnable tasks and claim/delivery windows, not just worker slots. */
  updateBlockers(): string[] {
    return this.submitting || this.active.size || this.scheduling || this.delivering ||
      this.store.events().some(event => this.parentEnabled(event.parent)) || this.store.list().some(task => this.parentEnabled(task.parent) && (task.status === "ready" || task.status === "running"))
      ? ["dispatcher work"] : [];
  }
  /** Executing operations, not work awaiting its next durable claim.
   * Non-active running claims need reconciliation, never silent lock stealing. */
  maintenanceBlockers(): string[] {
    const blockers: string[] = [];
    if (this.submitting || this.scheduling) blockers.push("dispatcher claim/submission in flight");
    if (this.active.size) blockers.push(`dispatcher executing: ${[...this.active.keys()].join(", ")}`);
    if (this.delivering) blockers.push("dispatcher delivery in flight");
    for (const task of this.store.list()) {
      if (task.status === "running" && !this.active.has(task.id)) blockers.push(`dispatcher stale claim: ${task.id}`);
      // The existing trusted decision boundary certifies an exact durable worker
      // report bound to this intent. Recovery may reassess it, never rerun effects.
      const settledReport = this.strategyFor(task)?.reconcile && this.strategyFor(task)?.decisionBoundary?.(task);
      if (task.intent && task.intent.replay === "unsafe" && task.intent.result === undefined && !settledReport)
        blockers.push(`dispatcher unresolved effect: ${task.id} (${task.intent.key})`);
    }
    return blockers;
  }
  async start(): Promise<void> {
    if (this.initialized) throw Error("Dispatcher already started");
    this.initialized = true;
    await this.store.recover(this.strategies, undefined, this.recoveryPolicy, task => this.parentEnabled(task.parent));
    this.recovered = true;
    await this.kick();
  }
  /** Explicit conversation selection may release only its retained, non-active workers. */
  async activateParent(parent: string): Promise<void> {
    if (!this.ready || !this.parentEnabled(parent)) return;
    await this.store.recover(this.strategies, undefined, this.recoveryPolicy,
      task => task.parent === parent && !this.active.has(task.id));
    await this.kick();
  }
  /** Host-only scheduled submission; never expose mandate as a model tool argument. */
  async submitScheduled(parent: string, requestId: string, input: string, mandate: NonNullable<Execution["dependency"]>, pinned?: Execution["pinned"]): Promise<Execution> {
    if (!this.recovered || this.stopped || this.admissionFenced()) throw Error("Dispatcher unavailable");
    if (pinned !== undefined) validateWorkerPin(pinned);
    this.submitting++;
    try {
      const task = await this.store.submit(parent, requestId, input, this.strategy.name, this.strategy.version, mandate, pinned, this.origin?.(parent));
      await this.kick();
      return task;
    } finally { this.submitting--; }
  }
  /** Versioned model-facing capability. Older hosts must fail closed, not ignore the assertion. */
  /** Host supplies the current turn identity; omission is never a context selector. */
  submitCurrent(parent: string, requestId: string, input: string): Promise<Execution> {
    const mandate = this.checkpoint?.(parent);
    if (!mandate?.taskId) return Promise.reject(Error("parent-mandate-missing: no active host task for delegation"));
    return this.submitBound(parent, requestId, input, mandate.taskId);
  }
  submitBound(parent: string, requestId: string, input: string, expectedTaskId: string): Promise<Execution> {
    return this.submit(parent, requestId, input, expectedTaskId);
  }
  async submit(parent: string, requestId: string, input: string, expectedTaskId?: string): Promise<Execution> {
    if (!this.recovered || this.stopped || this.admissionFenced()) throw Error("Dispatcher unavailable");
    this.submitting++;
    try {
      const mandate = this.checkpoint?.(parent);
      // An assertion, never a selector: model input cannot switch host authority.
      if (expectedTaskId !== undefined && (!expectedTaskId || mandate?.taskId !== expectedTaskId))
        throw Error("execution-context-mismatch: delegation must match the active host task");
      if (mandate?.expiresAt !== undefined && mandate.expiresAt <= Date.now())
        throw Error("deadline-expired: delegation deadline has elapsed");
      const task = await this.store.submit(parent, requestId, input, this.strategy.name, this.strategy.version, mandate, undefined, this.origin?.(parent));
      if (expectedTaskId !== undefined && task.dependency?.taskId !== expectedTaskId)
        throw Error("execution-context-mismatch: requestId already belongs to another task");
      await this.kick();
      return task;
    } finally { this.submitting--; }
  }
  async cancelParent(parent: string): Promise<void> {
    // Revoke durably before signalling workers; an in-flight result delivery
    // is also rejected by the Harness execution-time authority check.
    await this.store.cancelParent(parent);
    for (const task of this.store.list(parent)) this.active.get(task.id)?.abort.abort();
    // A scoped stop must not wait for unrelated scheduling or event delivery.
    void this.kick().catch(this.report);
  }
  async cancelTask(parent: string, taskId: string, preexistingUnscoped: readonly string[] = []): Promise<void> {
    await this.store.cancelTask(parent, taskId, preexistingUnscoped);
    for (const task of this.store.list(parent))
      if (task.dependency?.taskId === taskId || task.ownershipHold) this.active.get(task.id)?.abort.abort();
    void this.kick().catch(this.report);
  }
  /** Also called by host retry ticks; no model calls are used to poll task status. */
  kick(): Promise<void> {
    if (this.stopped || !this.recovered || this.admissionFenced()) return Promise.resolve();
    this.scheduleRequested = true;
    if (this.scheduling) return this.scheduling;
    this.scheduling = (async () => {
      do {
        this.scheduleRequested = false;
        await this.schedule();
      } while (this.scheduleRequested && !this.stopped && !this.admissionFenced());
    })().finally(() => { this.scheduling = undefined; });
    return this.scheduling;
  }
  private async schedule(): Promise<void> {
    void this.flushEvents().catch(this.report);
    const tasks = this.store.list().filter(task => !task.ownershipHold && task.recoveryEnrollment !== "held-legacy" &&
      !this.active.has(task.id) && this.parentEnabled(task.parent) && !!this.strategyFor(task) &&
      (task.status === "ready" && this.store.assessmentDue(task) ||
        ["worker-failed", "runtime-failure"].includes(task.diagnosticCode ?? "") && ["blocked", "paused", "ready"].includes(task.status) &&
        (!task.workerRetry || this.store.assessmentDue(task) || task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= Date.now())));
    while (tasks.length) {
      if (this.stopped || this.admissionFenced() || this.active.size >= this.capacity) break;
      let task = this.priorities.pick(tasks, task => task.id,
        task => this.parentPriority ? this.parentPriority(task) : task.dependency?.priority)!;
      tasks.splice(tasks.indexOf(task), 1);
      if (task.recoveryEnrollment === "held-legacy") continue;
      if (["worker-failed", "runtime-failure"].includes(task.diagnosticCode ?? "") &&
          (["blocked", "paused"].includes(task.status) || task.status === "ready" && task.workerRetry) &&
          !this.active.has(task.id) && this.parentEnabled(task.parent)) {
        if (task.workerRetry && !this.store.assessmentDue(task) &&
            !(task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= Date.now())) continue;
        const retained = this.strategyFor(task);
        if (retained) await this.store.retryWorker(task.id, retained, this.recoveryPolicy);
        task = this.store.list().find(row => row.id === task.id)!;
        if (task.status !== "ready") continue; // internal pause remains durably timed
      }
      if (task.status !== "ready" || !this.store.assessmentDue(task) || this.active.has(task.id) || !this.parentEnabled(task.parent)) continue;
      const strategy = this.strategyFor(task);
      if (!strategy) continue;
      let claimed: Execution;
      try {
        claimed = await this.store.claim(task.id, {
          strategy: strategy.name, version: strategy.version, replaySafe: strategy.replaySafe, reconcile: strategy.reconcile,
        }, this.recoveryPolicy);
      } catch (error) {
        if (error instanceof ExecutionClaimConflict) continue;
        throw error;
      }
      // stop() can arrive while the durable claim is committing.
      if (this.stopped) return;
      const current = this.store.list().find(item => item.id === claimed.id);
      if (current?.status !== "running" || current.token !== claimed.token) continue;
      if (this.admissionFenced() || !this.parentEnabled(claimed.parent)) {
        await this.store.releaseUnstartedClaim(claimed.id, claimed.token!, claimed.claimedRecoveryAction);
        continue;
      }
      const abort = new AbortController();
      const done = Promise.resolve().then(() => this.run(claimed, abort, strategy));
      this.active.set(task.id, { abort, done });
    }
  }
  private async run(task: Execution, abort: AbortController, strategy: DispatcherStrategy): Promise<void> {
    const token = task.token!;
    let decisionRevision = strategy.decisionBoundary ? 0 : undefined;
    const check = (): void => {
      const current = this.store.list().find(item => item.id === task.id);
      if (abort.signal.aborted || current?.status !== "running" || current.token !== token)
        throw new ExecutionClaimConflict("Dispatcher execution interrupted");
    };
    try {
      check();
      if (!this.parentEnabled(task.parent)) {
        await this.store.releaseUnstartedClaim(task.id, token, task.claimedRecoveryAction);
        return;
      }
      if (task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= Date.now())
        throw new ExecutionDeadlineExpired();
      const execute = () => strategy.execute(task, {
        signal: abort.signal,
        status: async text => {
          check();
          await this.store.report(task.id, token, text);
          // Notification transport must not fail productive execution. The durable
          // event remains queued until a later delivery attempt succeeds.
          void this.flushEvents().catch(this.report);
        },
        question: async text => {
          check(); await this.store.ask(task.id, token, text);
          void this.flushEvents().catch(this.report);
          throw new ExecutionClaimConflict("Execution waiting for answer");
        },
        deferAssessment: async nextAt => {
          check(); await this.store.deferAssessment(task.id, token, nextAt, decisionRevision);
          throw new ExecutionClaimConflict("Assessment deferred");
        },
        yieldStep: async () => {
          check();
          if (!this.admissionFenced() && !this.store.list().some(other => other.id !== task.id && other.status === "ready" &&
              this.store.assessmentDue(other) && this.parentEnabled(other.parent) && this.strategyFor(other))) return;
          await this.store.yieldStep(task.id, token);
          throw new ExecutionClaimConflict("Settled step yielded to queued work");
        },
        checkpoint: async (value, notice, revision) => {
          check(); await this.store.checkpoint(task.id, token, value, notice, revision);
          if (this.admissionFenced()) {
            const current = this.store.list().find(item => item.id === task.id)!;
            if (!current.intent) await this.store.yieldStep(task.id, token);
            else if (strategy.reconcile && strategy.decisionBoundary?.(current))
              await this.store.deferAssessment(task.id, token, Date.now() + 1, decisionRevision);
            else return; // Unknown outcome: retain ownership until actual settlement.
            throw new ExecutionClaimConflict("Maintenance checkpoint reached");
          }
        },
        archiveCompletedPlan: (segment, revision) => { check(); return this.store.archiveCompletedPlan(task.id, token, segment, revision); },
        workerSession: key => { check(); return this.store.workerSession(task.id, token, key); },
        decisions: async () => {
          check();
          const rows = await this.store.applyDecisions(task.id, token);
          decisionRevision = executionDecisionRevision(rows);
          return rows;
        },
        fenceDecisions: revision => this.store.fenceDecisions(task.id, token, revision),
        intent: async (key, replay, route, revision) => {
          check();
          await strategy.prepareWorker?.(task);
          check();
          return this.store.intent(task.id, token, key, replay, route, revision);
        },
        // Settlement alone is not a scheduling boundary: the strategy must first
        // apply its completion/blocked verdict. yieldStep then parks safe work.
        settleIntent: (key, result, checkpoint, revision) => { check(); return this.store.settleIntent(task.id, token, key, result, checkpoint, revision); },
      });
      const result = await (this.parallelAdmission ? this.parallelAdmission.run(async () => {
        check();
        if (task.dependency?.expiresAt !== undefined && task.dependency.expiresAt <= Date.now())
          throw new ExecutionDeadlineExpired();
        return execute();
      }, abort.signal) : execute());
      check();
      await this.store.complete(task.id, token, result, decisionRevision);
    } catch (error) {
      const current = this.store.list().find(row => row.id === task.id);
      if (error instanceof ExecutionDecisionConflict || (current?.status === "running" && current.token === token &&
          executionDecisionRevision(current.decisions) !== decisionRevision && strategy.decisionBoundary?.(current))) {
        await this.store.deferDecision(task.id, token).catch(this.report);
        return;
      }
      // Preserve partial state, but do not automatically spin on a failing plugin.
      if (!this.stopped && this.store.list().find(item => item.id === task.id)?.status === "running") {
        await this.store.fail(task.id, token, error instanceof ExecutionDeadlineExpired || toolGuardDenialReason(error).startsWith("deadline_expired:")
          ? "deadline-expired" : error instanceof ExecutionAssessmentStalled ? "assessment-stalled"
          : error instanceof ExecutionWorkerFailure ? error.diagnosticCode : "runtime-failure",
          { strategy, policy: this.recoveryPolicy,
            ...(error instanceof ExecutionAssessmentHold ? { assessmentHold: { state: error.state, step: error.step } } : {}) }).catch(this.report);
      }
      if (!abort.signal.aborted && !(error instanceof ExecutionClaimConflict)) this.report(error);
    } finally {
      this.active.delete(task.id);
      // Scheduling may still be filling other slots; recheck once that pass ends.
      const pending = this.scheduling;
      if (pending) void pending.then(() => this.kick()).catch(this.report);
      else void this.kick().catch(this.report);
    }
  }
  async continueReconciled(parent: string, id: string, requestId: string, executionHash: string, evidence: string, fingerprint: string, resumePaused = false): Promise<void> {
    if (this.active.has(id) || !this.parentEnabled(parent) || this.admissionFenced()) throw Error("Execution owner or host remains active/fenced");
    await this.store.continueReconciled(parent, id, requestId, executionHash, evidence, fingerprint, task => {
      if (this.active.has(id) || !this.parentEnabled(parent) || this.admissionFenced() || this.stopped) throw Error("Execution owner or host remains active/fenced");
      const strategy = this.strategyFor(task as Execution);
      if (!strategy?.reconcile || task.intent && (!task.recoverySession || !task.recoverySession.startsWith(`dispatch:${task.id}:`))) throw Error("Retained strategy/session cannot reconcile; no retry granted");
      const reason = recoveryBlock(task as Execution, strategy, this.recoveryPolicy);
      if (reason) throw Error("Host recovery policy still blocks continuation");
    }, resumePaused);
    await this.kick();
  }
  async resolve(parent: string, id: string, actor: string, action: "continue" | "retry", evidence: string): Promise<void> {
    const task = this.store.list(parent).find(task => task.id === id);
    if (!task) throw Error("Unknown execution in this conversation");
    if (action === "continue" && task.intent && !this.strategyFor(task)?.reconcile) throw Error("Strategy has no reconciliation support; choose explicit retry or cancel");
    await this.store.resolve(parent, id, actor, action, evidence);
    await this.kick();
  }
  async consolidateDecisions(parent: string, id: string, requestId: string, text: string, replaces: readonly string[], followUp?: import("./execution.js").ExecutionFollowUp, expectedRevision?: number): Promise<import("./execution.js").ExecutionDecision> {
    const task = this.store.list(parent).find(item => item.id === id);
    if (!task) throw Error("Execution not in this conversation");
    const strategy = this.strategyFor(task);
    if (!strategy?.decisionBoundary) throw Error("Strategy has no retained assessment decision boundary");
    const receipt = await this.store.consolidateDecisions(parent, id, requestId, text, replaces, current => strategy.decisionBoundary!(current), followUp, expectedRevision);
    await this.kick(); return receipt;
  }
  async decide(parent: string, id: string, requestId: string, text: string, expectedRevision?: number): Promise<import("./execution.js").ExecutionDecision> {
    if (/^(dispatch|subagent):/.test(parent)) throw Error("Nested worker decisions are disabled");
    const task = this.store.list(parent).find(row => row.id === id);
    if (!task) throw Error("Unknown execution in this conversation");
    const strategy = this.strategyFor(task);
    if (!strategy?.decisionBoundary) throw Error("Strategy does not support parent decisions");
    const receipt = await this.store.recordDecision(parent, id, requestId, text, current => strategy.decisionBoundary!(current), expectedRevision);
    await this.kick();
    return receipt;
  }
  async reopenContradictoryCompletion(parent: string, id: string, requestId: string, text: string, checkpointHash: string, expectedRevision: number): Promise<Execution> {
    const task = await this.store.reopenContradictoryCompletion(parent, id, requestId, text, checkpointHash, expectedRevision);
    await this.kick(); return task;
  }
  async answer(parent: string, id: string, questionId: string, text: string): Promise<void> {
    await this.store.answer(parent, id, questionId, text);
    await this.kick();
  }
  async control(parent: string, id: string, action: "pause" | "resume" | "cancel"): Promise<void> {
    if (!this.store.list(parent).some(task => task.id === id)) throw Error("Unknown execution in this conversation");
    await this.store.control(id, action);
    if (action !== "resume") this.active.get(id)?.abort.abort();
    await this.kick();
  }
  /** Host fence: durable cancellation alone does not mean execution has drained. */
  async waitForExecution(id: string): Promise<void> {
    await this.scheduling;
    await this.active.get(id)?.done;
  }
  /** Exact stopped scope only: never wait on another parent's scheduling. */
  async drainRevokedExecution(id: string): Promise<void> {
    const task = this.store.list().find(task => task.id === id);
    if (!task || task.status !== "cancelled" && !task.parentStopped)
      throw Error("Scoped drain requires durable execution revocation");
    // Late claims recheck live ownership before publishing/executing a worker.
    await this.active.get(id)?.done;
  }
  flushEvents(): Promise<void> {
    if (this.delivering) return this.delivering;
    if (this.admissionFenced()) return Promise.resolve();
    this.delivering = (async () => {
      while (!this.stopped) {
        const events = this.store.events().filter(event => this.parentEnabled(event.parent) &&
          !this.store.list(event.parent).find(task => task.id === event.executionId)?.ownershipHold);
        if (!events.length) return;
        for (const event of events) {
          if (this.stopped || this.admissionFenced()) return;
          if (!this.parentEnabled(event.parent)) continue;
          // Receiver must durably deduplicate by event.id before acknowledging.
          // Failures leave the event pending and reject; never spin on failure.
          await this.deliver(event);
          await this.store.ack(event.id);
        }
        // Commits during delivery must not depend on another external tick.
      }
    })().finally(() => { this.delivering = undefined; });
    return this.delivering;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const worker of this.active.values()) worker.abort.abort();
    await this.scheduling;
    await Promise.allSettled([...this.active.values()].map(worker => worker.done));
    await this.delivering?.catch(this.report);
  }
}
