import type { ExecutionRecoveryPolicy } from "./execution-recovery.js";
import { ExecutionClaimConflict, type Execution, type ExecutionEvent, type ExecutionStore } from "./execution.js";

export interface DispatchContext {
  readonly signal: AbortSignal;
  checkpoint(value: string): Promise<void>;
  workerSession?(key: string): Promise<void>;
  /** Optional only for source compatibility with existing strategy test adapters. */
  status?(text: string): Promise<void>;
  /** Persists a question and suspends this execution; never returns normally. */
  question?(text: string): Promise<never>;
  intent(key: string, replay: "safe" | "unsafe"): Promise<void>;
  settleIntent(key: string, result: string, checkpoint: string): Promise<void>;
}
/** Trusted plugins supply policy; no model-generated field grants replay permission. */
export interface DispatcherStrategy {
  name: string;
  version: number;
  replaySafe: boolean;
  reconcile?: boolean;
  execute(task: Readonly<Execution>, context: DispatchContext): Promise<string>;
}

/** Parent revocation belongs to persistence even when scheduling is disabled. */
export async function stopDispatcherParent(store: ExecutionStore, parent: string, dispatcher?: Dispatcher): Promise<void> {
  if (dispatcher) await dispatcher.cancelParent(parent);
  else await store.cancelParent(parent);
}

/** Event-driven host scheduler. Number of durable tasks is independent of active
 * capacity. A paused worker retains its slot until it actually settles. */
export class Dispatcher {
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private scheduling?: Promise<void>;
  private scheduleRequested = false;
  private delivering?: Promise<void>;
  private stopped = false;
  private initialized = false;
  private recovered = false;
  constructor(
    readonly store: ExecutionStore,
    private readonly strategy: DispatcherStrategy,
    private readonly capacity: number,
    private readonly deliver: (event: ExecutionEvent) => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly checkpoint?: (parent: string) => Execution["dependency"],
    private readonly recoveryPolicy?: ExecutionRecoveryPolicy,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid dispatcher capacity");
    if (!strategy.name.trim() || !Number.isSafeInteger(strategy.version) || strategy.version < 1) throw Error("Invalid dispatcher strategy");
  }
  async start(): Promise<void> {
    if (this.initialized) throw Error("Dispatcher already started");
    this.initialized = true;
    await this.store.recover(new Map([[this.strategy.name, this.strategy]]), undefined, this.recoveryPolicy);
    this.recovered = true;
    await this.kick();
  }
  async submit(parent: string, requestId: string, input: string): Promise<Execution> {
    if (!this.recovered || this.stopped) throw Error("Dispatcher unavailable");
    const task = await this.store.submit(parent, requestId, input, this.strategy.name, this.strategy.version, this.checkpoint?.(parent));
    await this.kick();
    return task;
  }
  async cancelParent(parent: string): Promise<void> {
    // Revoke durably before signalling workers; an in-flight result delivery
    // is also rejected by the Harness execution-time authority check.
    await this.store.cancelParent(parent);
    for (const task of this.store.list(parent)) this.active.get(task.id)?.abort.abort();
    await this.kick();
  }
  /** Also called by host retry ticks; no model calls are used to poll task status. */
  kick(): Promise<void> {
    if (this.stopped || !this.recovered) return Promise.resolve();
    this.scheduleRequested = true;
    if (this.scheduling) return this.scheduling;
    this.scheduling = (async () => {
      do {
        this.scheduleRequested = false;
        await this.schedule();
      } while (this.scheduleRequested && !this.stopped);
    })().finally(() => { this.scheduling = undefined; });
    return this.scheduling;
  }
  private async schedule(): Promise<void> {
    void this.flushEvents().catch(this.report);
    for (const task of this.store.list()) {
      if (this.stopped || this.active.size >= this.capacity) break;
      if (task.status !== "ready" || this.active.has(task.id)) continue;
      if (task.strategy !== this.strategy.name || task.strategyVersion !== this.strategy.version) continue;
      let claimed: Execution;
      try {
        claimed = await this.store.claim(task.id, {
          strategy: this.strategy.name, version: this.strategy.version, replaySafe: this.strategy.replaySafe, reconcile: this.strategy.reconcile,
        }, this.recoveryPolicy);
      } catch (error) {
        if (error instanceof ExecutionClaimConflict) continue;
        throw error;
      }
      // stop() can arrive while the durable claim is committing.
      if (this.stopped) return;
      const abort = new AbortController();
      const done = Promise.resolve().then(() => this.run(claimed, abort));
      this.active.set(task.id, { abort, done });
    }
  }
  private async run(task: Execution, abort: AbortController): Promise<void> {
    const token = task.token!;
    const check = (): void => { if (abort.signal.aborted) throw Error("Dispatcher execution interrupted"); };
    try {
      const result = await this.strategy.execute(task, {
        signal: abort.signal,
        status: async text => { check(); await this.store.report(task.id, token, text); await this.flushEvents(); },
        question: async text => {
          check(); await this.store.ask(task.id, token, text);
          void this.flushEvents().catch(this.report);
          throw new ExecutionClaimConflict("Execution waiting for answer");
        },
        checkpoint: value => { check(); return this.store.checkpoint(task.id, token, value); },
        workerSession: key => { check(); return this.store.workerSession(task.id, token, key); },
        intent: (key, replay) => { check(); return this.store.intent(task.id, token, key, replay); },
        settleIntent: (key, result, checkpoint) => { check(); return this.store.settleIntent(task.id, token, key, result, checkpoint); },
      });
      check();
      await this.store.complete(task.id, token, result);
    } catch (error) {
      // Preserve partial state, but do not automatically spin on a failing plugin.
      if (!this.stopped && this.store.list().find(item => item.id === task.id)?.status === "running") {
        await this.store.control(task.id, "pause").catch(this.report);
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
  async resolve(parent: string, id: string, actor: string, action: "continue" | "retry", evidence: string): Promise<void> {
    const task = this.store.list(parent).find(task => task.id === id);
    if (!task) throw Error("Unknown execution in this conversation");
    if (action === "continue" && task.intent && !this.strategy.reconcile) throw Error("Strategy has no reconciliation support; choose explicit retry or cancel");
    await this.store.resolve(parent, id, actor, action, evidence);
    await this.kick();
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
  flushEvents(): Promise<void> {
    if (this.delivering) return this.delivering;
    this.delivering = (async () => {
      while (!this.stopped) {
        const events = this.store.events();
        if (!events.length) return;
        for (const event of events) {
          if (this.stopped) return;
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
