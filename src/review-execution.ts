import { randomUUID } from "node:crypto";
import type { AgentRuntime } from "./types.js";
import { Dispatcher } from "./dispatcher.js";
import { ExecutionStore } from "./execution.js";

/** Execution transport only. Review routing and verdict/budget remain plugin-owned. */
export interface ReviewExecutionRequest {
  cwd: string; sessionKey: string; fingerprint: string; prompt: string;
  model?: string; thinking: string; signal?: AbortSignal;
}
export interface ReviewExecutionReceipt {
  kind: "dispatcher-worker" | "subagent" | "handover-worktree";
  executionId: string; isolated: true; fingerprint: string; result: string;
}
export interface DedicatedReviewExecution {
  dispatcherEnabled(): boolean;
  dispatcherWorker?(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt>;
  subagent?(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt>;
  handoverWorktree?(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt>;
}

/** Separate tool-free runtime session: no Harness working-turn/policy recursion. */
export async function isolatedReview(runtime: AgentRuntime, key: string, request: ReviewExecutionRequest, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw Error("Review cancelled");
  const session = await runtime.open(key, { ephemeral: true });
  let aborting: Promise<void> | undefined;
  const abort = () => { aborting ??= Promise.resolve().then(() => session.abort()).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw Error("Review cancelled");
    const text = await session.prompt(request.prompt, { model: request.model, thinking: request.thinking });
    if (signal?.aborted) throw Error("Review cancelled");
    return text;
  } finally {
    signal?.removeEventListener("abort", abort);
    await aborting;
    await session.dispose();
  }
}

/** Durable dedicated worker scheduler, separate from working-tool dispatch capacity.
 * This is an execution ledger, NOT another review ledger or another review budget.
 */
export class ReviewWorkers {
  private dispatcher: Dispatcher;
  private startup?: Promise<void>;
  private closed = false;
  constructor(private readonly runtime: AgentRuntime, private readonly store: ExecutionStore, capacity = 1) {
    this.dispatcher = new Dispatcher(store, {
      name: "dedicated-review", version: 1, replaySafe: true,
      execute: async (task, context) => {
        const request = JSON.parse(task.input) as Omit<ReviewExecutionRequest, "signal">;
        const sessionKey = `dispatch:${task.id}:${task.token}`;
        await context.workerSession?.(sessionKey);
        return isolatedReview(this.runtime, sessionKey, request, context.signal);
      },
    }, capacity, async () => {}, error => console.error(`[review-worker] ${error instanceof Error ? error.name : "failure"}`));
  }
  private start(): Promise<void> {
    if (this.closed) return Promise.reject(Error("Review worker scheduler stopped"));
    return this.startup ??= (async () => {
      await this.store.load();
      // A dead caller cannot consume a recovered review result. Do not spend a
      // new model invocation outside its still-owned review round.
      for (const task of this.store.list()) {
        if (!["completed", "cancelled"].includes(task.status)) await this.store.control(task.id, "cancel");
      }
      await this.dispatcher.start();
    })();
  }
  async review(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt> {
    await this.start();
    if (request.signal?.aborted || this.closed) throw Error("Review cancelled");
    const { signal, ...data } = request;
    const deadline = Date.now() + 120000;
    const task = await this.dispatcher.submit(request.sessionKey, `review:${randomUUID()}`, JSON.stringify(data));
    try {
      for (;;) {
        if (signal?.aborted || this.closed) throw Error("Review cancelled");
        if (Date.now() >= deadline) throw Error("Dedicated review worker timed out");
        const current = this.store.list(request.sessionKey).find(item => item.id === task.id)!;
        if (current.status === "completed") return { kind: "dispatcher-worker", executionId: task.id,
          isolated: true, fingerprint: request.fingerprint, result: current.result ?? "" };
        if (["blocked", "cancelled", "paused"].includes(current.status)) throw Error("Dedicated review worker did not complete");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally {
      const current = this.store.list(request.sessionKey).find(item => item.id === task.id);
      if (current && !["completed", "cancelled"].includes(current.status)) await this.dispatcher.control(request.sessionKey, task.id, "cancel");
      await this.dispatcher.waitForExecution(task.id);
    }
  }
  async stop(): Promise<void> { this.closed = true; await this.startup?.catch(() => {}); await this.dispatcher.stop(); }
}
