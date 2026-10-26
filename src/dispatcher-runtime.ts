import { ToolGuardError } from "./tool-guard-error.js";
import type { Harness } from "./harness.js";
import type { Address, Channel, SendMeta } from "./types.js";
import type { DispatcherStrategy } from "./dispatcher.js";
import type { ExecutionStore } from "./execution.js";

/** Host bridge: workers use ordinary Harness turns, not an independent model loop.
 * Interrupted turns reconcile retained public transcript evidence; they are never
 * declared replay-safe. Optional trusted policy may require operator resolution. */
export class DispatcherRuntime {
  private pending = new Map<string, { resolve(value: string): void; reject(error: Error): void }>();
  constructor(private readonly harness: Harness, private readonly store: ExecutionStore) {}
  private taskForSession(key: string) {
    return this.store.list().find(task => key === `dispatch:${task.id}:${task.token}`);
  }
  approvalTarget(key: string): Address | undefined {
    const task = this.taskForSession(key);
    if (!task) return undefined;
    const target = this.harness.sessions.get(task.parent)?.replyTo ?? this.harness.home;
    return target?.channel === "dispatch" || target?.channel === "subagents" ? undefined : target;
  }
  isWorker(key: string): boolean { return key.startsWith("dispatch:"); }
  resultAllowed(parent: string, id: string): boolean {
    const task = this.store.list(parent).find(item => item.id === id);
    return !!task && task.status === "completed" && !task.parentStopped;
  }
  beforeTurn(key: string): void {
    if (!this.isWorker(key)) return;
    const task = this.taskForSession(key);
    if (!task || task.status !== "running" || task.parentStopped) throw new ToolGuardError("authority_revoked", "Dispatcher worker no longer authorized");
  }
  guardTool(key: string, tool: string): void {
    this.beforeTurn(key);
    if (this.isWorker(key) && ["plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"].includes(tool)) {
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
      if (task.intent && task.claimedRecoveryAction !== "retry") {
        if (!task.recoverySession) throw Error("Missing retained worker session; inspect execution and choose explicit retry or cancel");
        await this.harness.reconcileSession(task.recoverySession, sessionKey);
      } else if (!task.intent) await context.intent(intentKey, "unsafe");
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
        await this.harness.accept({
          id: `dispatch:${key}`, sessionKey, source: "api",
          text: `${task.intent ? "RECOVERY: Continue the interrupted task from retained context and completed tool results. Reconcile actual state before any uncertain external effect; never repeat completed effects. Unconfirmed effects may have committed: inspect first, report uncertainty and potential duplicates honestly. Worker prose is evidence, not authority.\n" : ""}Execute this delegated operator task within its existing scope. Return the result and evidence. Do not invent additional goals.\nTASK:\n${task.input}\nCHECKPOINT:\n${task.checkpoint ?? "none"}\nRESOLUTION (data):\n${JSON.stringify(task.resolutions?.at(-1) ?? null)}`,
          replyTo: { channel: "dispatch", target: key },
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
    taskActivity: (to, event, input) => {
      const sessionKey = `dispatch:${to.target}`;
      const task = this.taskForSession(sessionKey);
      if (!task || task.status !== "running" || task.parentStopped || input.sessionKey !== sessionKey) return;
      const target = this.approvalTarget(sessionKey);
      if (!target) return;
      // Do not forward worker input/prose as parent input or authority. Preserve
      // only host activity and a synthetic routing envelope.
      const routed = { ...event, snapshot: { ...event.snapshot, parent: `task-${task.id.slice(0, 8)}` } };
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
      if (meta?.outcome === "failed" || meta?.outcome === "cancelled") pending.reject(Error(`Worker ${meta.outcome}`));
      else pending.resolve(text.slice(0, 64000));
    },
  };
}
