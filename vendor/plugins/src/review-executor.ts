import type { AssessmentBackend } from "./assessment-backend.js";

export interface ReviewModelPair { model?: string; thinking?: string }
export interface ReviewHttpReceipt {
  phase: "initial" | "fallback" | "observed";
  actual: ReviewModelPair;
  executionId: string;
  /** Fully observed numeric 429 of the initial SDK HTTP attempt. */
  initialRejected429?: true;
  result?: string;
  terminal?: "rejected" | "invalid";
}
export interface ReviewHttpContext {
  id: string;
  promptDigest: string;
  requested: ReviewModelPair;
  defaults: ReviewModelPair;
  persist(receipt: ReviewHttpReceipt): Promise<void>;
  consumed(): boolean;
  closed(): ReviewHttpReceipt | undefined;
}
export interface ReviewExecutionRequest {
  httpAssessment?: ReviewHttpContext;
  cwd: string;
  sessionKey: string;
  fingerprint: string;
  prompt: string;
  model?: string;
  thinking: string;
  signal?: AbortSignal;
}
export interface ReviewExecutionReceipt {
  kind: "dispatcher-worker" | "subagent" | "handover-worktree";
  executionId: string;
  isolated: true;
  fingerprint: string;
  result: string;
}
/** Host supplies execution capabilities; plugin owns mandatory routing policy. */
export interface DedicatedReviewExecution {
  dispatcherEnabled(): boolean;
  httpSelection?(model: string | undefined, thinking: string): Promise<{ requested: ReviewModelPair; defaults: ReviewModelPair } | undefined>;
  dispatcherWorker?(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt>;
  subagent?(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt>;
  handoverWorktree?(request: ReviewExecutionRequest): Promise<ReviewExecutionReceipt>;
}

export function dedicatedReviewBackend(execution: DedicatedReviewExecution | undefined,
  identity: Pick<ReviewExecutionRequest, "cwd" | "sessionKey" | "fingerprint" | "httpAssessment">): AssessmentBackend {
  return { async review(prompt, model, thinking, signal) {
    if (!execution) throw Error("Dedicated review execution unavailable; self-review is forbidden");
    const request = { ...identity, prompt, model, thinking, signal };
    const enabled = execution.dispatcherEnabled();
    const primary = enabled ? execution.dispatcherWorker : execution.subagent;
    const kind = enabled ? "dispatcher-worker" : "subagent";
    let receipt: ReviewExecutionReceipt;
    try {
      if (!primary) throw Error(`Dedicated ${kind} unavailable`);
      receipt = await primary.call(execution, request);
    } catch (error) {
      if (signal?.aborted) throw Error("Review cancelled");
      if (identity.httpAssessment?.consumed()) throw error;
      // No new model round or ledger: same reserved review attempt, same bytes.
      // Host fallback must retire/fence the primary before starting replacement.
      if (!execution.handoverWorktree) throw error;
      receipt = await execution.handoverWorktree(request);
      if (receipt.kind !== "handover-worktree") throw Error("Invalid handover review receipt");
    }
    if (signal?.aborted) throw Error("Review cancelled");
    if (!receipt || receipt.isolated !== true || !receipt.executionId?.trim() ||
        receipt.fingerprint !== identity.fingerprint ||
        ![kind, "handover-worktree"].includes(receipt.kind) || typeof receipt.result !== "string") {
      throw Error("Dedicated review isolation/candidate receipt mismatch");
    }
    if (identity.httpAssessment) {
      const closed = identity.httpAssessment.closed();
      if (!closed || closed.phase !== "observed" || closed.executionId !== receipt.executionId || closed.result !== receipt.result) {
        throw Error("Dedicated HTTP review closed receipt mismatch");
      }
    }
    return receipt.result;
  } };
}
