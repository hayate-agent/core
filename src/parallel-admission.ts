import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentRuntime } from "./types.js";

/** Shared model-work budget. Nested validators reuse their parent task's slot. */
export class ParallelAdmission {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly scope = new AsyncLocalStorage<{ held: boolean }>();
  constructor(private readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw Error("Invalid parallel capacity");
  }
  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (this.scope.getStore()?.held) return work();
    await new Promise<void>((resolve, reject) => {
      const cancel = () => {
        const index = this.waiting.indexOf(enter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason ?? Error("Admission cancelled"));
      };
      const enter = () => { signal?.removeEventListener("abort", cancel); this.active++; resolve(); };
      if (this.active < this.capacity) enter();
      else { this.waiting.push(enter); signal?.addEventListener("abort", cancel, { once: true }); }
    });
    const lease = { held: true };
    try { signal?.throwIfAborted(); return await this.scope.run(lease, work); }
    finally { lease.held = false; this.active--; this.waiting.shift()?.(); }
  }
}

const budgets = new WeakMap<object, ParallelAdmission>();
export function bindParallelAdmission(runtime: AgentRuntime, admission: ParallelAdmission): void {
  if (budgets.has(runtime)) return;
  budgets.set(runtime, admission);
  // Cover dedicated HTTP validators too, including isolated review worktrees.
  const review = runtime.reviewCodeHttp?.bind(runtime);
  if (review) runtime.reviewCodeHttp = (prompt, assessment, id, signal) => admission.run(() => review(prompt, assessment, id, signal), signal);
  const classify = runtime.classifyComplexityHttp?.bind(runtime);
  if (classify) runtime.classifyComplexityHttp = request => admission.run(() => classify(request), request.signal);
  const fork = runtime.forReviewWorktree?.bind(runtime);
  if (fork) runtime.forReviewWorktree = cwd => { const isolated = fork(cwd); bindParallelAdmission(isolated, admission); return isolated; };
}
export function auxiliaryAdmission<T>(runtime: object, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return budgets.get(runtime)?.run(work, signal) ?? work();
}
