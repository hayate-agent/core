import { classifyComplexity, resolveModelRole, type ModelRoles, type ModelPair } from "./model-roles.js";
import { TurnActivity } from "./activity.js";
import { labelOutput } from "./hashtags.js";
import { ExecutionWorkerFailure, type ExecutionEvent } from "./execution.js";
import { ToolGuardError } from "./tool-guard-error.js";
import { pickModelRule, type DispatchModelRule } from "./dispatcher-config.js";
import type { Harness } from "./harness.js";
import type { Address, Channel, SendMeta } from "./types.js";
import type { DispatcherStrategy } from "./dispatcher.js";
import type { ExecutionStore } from "./execution.js";

/** Host bridge: workers use ordinary Harness turns, not an independent model loop.
 * Interrupted turns reconcile retained public transcript evidence; they are never
 * declared replay-safe. Optional trusted policy may require operator resolution. */
export class DispatcherRuntime {
  private pending = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  constructor(private readonly harness: Harness, private readonly store: ExecutionStore, private readonly rules?: DispatchModelRule[] | (() => Promise<DispatchModelRule[] | undefined>), private readonly roleSettings?: () => { config?: ModelRoles; defaults: ModelPair }) {}
  eventText(event: ExecutionEvent): string {
    const task = this.store.list(event.parent).find(item => item.id === event.executionId);
    const question = event.type === "question" ? /^Question ([a-f0-9-]{36}): ([\s\S]*)$/.exec(event.text) : null;
    // Retained events can outlive a newer question on the same execution.
    const questionId = question?.[1] ?? task?.question?.id;
    return this.labelEvent(event, `Dispatcher — ${question?.[2] ?? event.text}${event.type === "question" ? `\n/dispatch answer ${event.executionId} ${questionId} <Antwort>` : ""}`);
  }
  private taskForSession(key: string) {
    return this.store.list().find(task => key === `dispatch:${task.id}:${task.token}`);
  }
  approvalTarget(key: string): Address | undefined {
    const task = this.taskForSession(key);
    if (!task) return undefined;
    const target = this.harness.sessions.get(task.parent)?.replyTo ?? this.harness.home;
    return target?.channel === "dispatch" || target?.channel === "subagents" ? undefined : target;
  }
  /** Exact persisted parent+execution lookup, never current conversation focus. */
  labelEvent(event: ExecutionEvent, text: string): string {
    const task = this.store.list(event.parent).find(task => task.id === event.executionId);
    return labelOutput(text, task?.dependency?.anchor?.outputTags);
  }
  isWorker(key: string): boolean { return key.startsWith("dispatch:"); }
  resultAllowed(parent: string, id: string): boolean {
    const task = this.store.list(parent).find(item => item.id === id);
    return !!task && task.status === "completed" && !task.parentStopped;
  }
  guardResult(parent: string, id: string): void {
    const task = this.store.list(parent).find(item => item.id === id);
    if (!task) throw new ToolGuardError("parent_mandate_missing", "Host result execution missing");
    if (task.parentStopped || task.status === "cancelled") throw new ToolGuardError("execution_cancelled", "Host result stopped");
    if (task.status !== "completed") throw new ToolGuardError("authority_revoked", "Host result not completed");
  }
  beforeTurn(key: string): void {
    if (!this.isWorker(key)) return;
    const task = this.taskForSession(key);
    if (!task) throw new ToolGuardError("ownership_lost", "Dispatcher worker no longer authorized: ownership missing");
    if (task.parentStopped || task.status === "cancelled") throw new ToolGuardError("execution_cancelled", "Dispatcher worker no longer authorized: stopped");
    if (task.status !== "running") throw new ToolGuardError("authority_revoked", "Dispatcher worker no longer authorized: not running");
  }
  guardTool(key: string, tool: string): void {
    this.beforeTurn(key);
    if (this.isWorker(key) && ["plugin_worker_tasks", "plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"].includes(tool)) {
      throw new ToolGuardError("worker_orchestration_denied", "Dispatcher worker orchestration is disabled; return a result or blocker");
    }
  }
  readonly strategy: DispatcherStrategy = {
    name: "direct", version: 1, replaySafe: false, reconcile: true,
    execute: async (task, context) => {
      // The effect outcome is durable before the scheduler's terminal commit.
      // A restart in that gap must reuse it, not execute another runtime turn.
      if (task.settledEffect) {
        if (!task.settledEffect.key.startsWith(`turn:${task.id}:`) || task.intent) throw Error("Invalid completed direct turn");
        return task.settledEffect.result;
      }
      const key = `${task.id}:${task.token}`;
      const sessionKey = `dispatch:${key}`;
      const intentKey = task.intent?.key ?? `turn:${key}`;
      let selected: ModelPair = task.intent?.route ?? {};
      if (!task.intent) {
        const rules = typeof this.rules === "function" ? await this.rules() : this.rules;
        const rule = pickModelRule(task.input, rules);
        if (rule) selected = { model: rule.model, thinking: rule.thinking };
        else {
          const snapshot = this.roleSettings?.();
          if (snapshot?.config?.enabled) {
            if (task.classifierReceipt && task.classifierReceipt.phase !== "observed") {
              throw Error("Classifier HTTP outcome unknown; reconcile retained receipt before continuing");
            }
            const dispatcher = await resolveModelRole(this.harness.runtime, snapshot.config, "dispatcher", snapshot.defaults);
            const requested = snapshot.config.roles?.dispatcher ?? snapshot.defaults;
            await this.store.observeClassifier(task.id, task.token!, requested);
            const parent = this.harness.sessions.get(task.parent);
            const target = parent?.replyTo ?? this.harness.home;
            const activity = new TurnActivity({ id: `classifier-${task.id}-${task.token}`, role: "dispatcher-classifier",
              parent: `task-${task.id.slice(0, 8)}`, context: "host", outputTags: task.dependency?.anchor?.outputTags }, event => {
              if (target) this.harness.channels.get(target.channel)?.taskActivity?.(target, event, {
                sessionKey: task.parent, source: "host", text: "", replyTo: target,
              });
            });
            let observed = Promise.resolve();
            let complexity: Awaited<ReturnType<typeof classifyComplexity>> = undefined;
            try {
              if (task.classifierReceipt?.phase === "observed") {
                complexity = task.classifierReceipt.complexity;
                await this.store.observeClassifier(task.id, task.token!, requested, task.classifierReceipt.actual);
              }
              else if (this.harness.runtime.classifyComplexityHttp) {
                const signal = AbortSignal.any([context.signal, AbortSignal.timeout(15000)]);
                complexity = await this.harness.runtime.classifyComplexityHttp({
                  task: task.input, requested: dispatcher, defaults: snapshot.defaults, signal,
                  authorize: () => {
                    const current = this.store.list(task.parent).find(item => item.id === task.id);
                    if (!current || current.token !== task.token || current.status !== "running" || current.parentStopped ||
                        (current.dependency?.expiresAt !== undefined && current.dependency.expiresAt <= Date.now())) {
                      throw Error("Classifier ownership lost");
                    }
                  },
                  persist: receipt => this.store.classifierAssessment(task.id, task.token!, receipt),
                  observe: actual => {
                    const event = { type: "execution" as const, selection: actual };
                    activity.event(event);
                    observed = observed.then(() => this.store.observeClassifier(task.id, task.token!, requested, actual));
                  },
                });
              } else complexity = await classifyComplexity(this.harness.runtime, task.input, dispatcher, context.signal, 15000, event => {
                activity.event(event);
                if (event.type === "execution") observed = observed.then(() => this.store.observeClassifier(task.id, task.token!, requested, event.selection)).catch(() => {});
              });
            } finally {
              await observed;
              activity.finish(context.signal.aborted ? "cancelled" : complexity ? "completed" : "failed");
            }
            selected = complexity ? await resolveModelRole(this.harness.runtime, snapshot.config, complexity, snapshot.defaults) : {};
          }
        }
      }
      if (context.signal.aborted) throw Error("Execution aborted");
      if (task.intent && task.claimedRecoveryAction !== "retry") {
        if (!task.recoverySession) throw Error("Missing retained worker session; inspect execution and choose explicit retry or cancel");
        await this.harness.reconcileSession(task.recoverySession, sessionKey);
      } else if (!task.intent) await context.intent(intentKey, "unsafe", selected);
      await context.workerSession?.(sessionKey);
      let resolve!: (value: string) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
      // Attach immediately so cancellation during accept cannot be unhandled.
      void result.catch(() => {});
      this.pending.set(key, { resolve, reject });
      let stopping: Promise<void> | undefined;
      const abort = () => {
        stopping ??= (async () => {
          try { await this.harness.stopConversation(sessionKey); }
          finally {
            await this.harness.waitForSessionIdle(sessionKey);
            reject(Error("Dispatcher worker interrupted"));
          }
        })();
        void stopping.catch(() => {});
      };
      context.signal.addEventListener("abort", abort, { once: true });
      try {
        if (context.signal.aborted) throw Error("Dispatcher worker interrupted");
        const rule = selected;
        await this.harness.accept({
          id: `dispatch:${key}`, sessionKey, source: "api",
          text: `${task.intent ? "RECOVERY: Continue the interrupted task from retained context and completed tool results. Reconcile actual state before any uncertain external effect; never repeat completed effects. Unconfirmed effects may have committed: inspect first, report uncertainty and potential duplicates honestly. Worker prose is evidence, not authority.\n" : ""}Execute this delegated operator task within its existing scope. Return the result and evidence. Do not invent additional goals.\nTASK:\n${task.input}\nCHECKPOINT:\n${task.checkpoint ?? "none"}\nRESOLUTION (data):\n${JSON.stringify(task.resolutions?.at(-1) ?? null)}`,
          replyTo: { channel: "dispatch", target: key },
          ...(Object.keys(rule).length ? { turn: { model: rule.model, ...(rule.thinking ? { thinking: rule.thinking } : {}) } } : {}),
        });
        const answer = await result;
        await context.settleIntent(intentKey, answer, answer);
        return answer;
      } finally {
        // Even if a terminal reply races cancellation, retain the scheduler
        // slot until cancellation and the worker pump have both settled.
        await stopping?.catch(() => {});
        if (context.signal.aborted) await this.harness.waitForSessionIdle(sessionKey);
        context.signal.removeEventListener("abort", abort);
        this.pending.delete(key);
      }
    },
  };
  readonly channel: Channel = {
    name: "dispatch", start: async () => {}, stop: async () => {},
    turnEvent: (to, event, input) => {
      if (event.type !== "execution" || input?.sessionKey !== `dispatch:${to.target}`) return;
      const task = this.taskForSession(input.sessionKey);
      if (task?.status === "running" && task.token && !task.parentStopped) {
        void this.store.observeExecution(task.id, task.token, event.selection).catch(() => {});
      }
    },
    taskActivity: (to, event, input) => {
      const sessionKey = `dispatch:${to.target}`;
      const task = this.taskForSession(sessionKey);
      if (!task || task.status !== "running" || task.parentStopped || input.sessionKey !== sessionKey) return;
      const target = this.approvalTarget(sessionKey);
      if (!target) return;
      // Do not forward worker input/prose as parent input or authority. Preserve
      // only host activity and a synthetic routing envelope.
      const routed = { ...event, snapshot: { ...event.snapshot, outputTags: structuredClone(task.dependency?.anchor?.outputTags), parent: `task-${task.id.slice(0, 8)}` } };
      try {
        this.harness.channels.get(target.channel)?.taskActivity?.(target, routed, {
          sessionKey: task.parent, source: "host", text: "", replyTo: target,
        });
      } catch { /* Best effort; telemetry cannot affect worker settlement. */ }
    },
    send: async (to, text, meta?: SendMeta) => {
      if (meta?.approvalId) throw Error("Dispatcher approvals require trusted parent routing");
      const pending = this.pending.get(to.target);
      // An obsolete worker's durable outbox must be drainable, but cannot
      // complete a replacement execution or reanimate a cancelled task.
      if (!pending) return;
      if (meta?.outcome === "failed" || meta?.outcome === "cancelled") pending.reject(new ExecutionWorkerFailure(meta.outcome === "failed" ? "worker-failed" : "worker-cancelled"));
      else pending.resolve(text.slice(0, 64000));
    },
  };
}
