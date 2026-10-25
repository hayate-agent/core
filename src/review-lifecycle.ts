import type { Inbound, PromptOptions, RuntimeSession } from "./types.js";
import { requiresReview } from "./review-scope.js";
import type { ReviewService } from "./review.js";

/** Shares the working session; reviewer calls are isolated by the backend. */
export async function finishWithReview(service: ReviewService, cwd: string, input: Inbound, reply: string, session: RuntimeSession, options: PromptOptions, signal?: AbortSignal): Promise<string> {
  if (!service.config.enabled || !service.config.mandatory.local) return reply;
  let change;
  try { change = await service.changes(cwd); }
  catch (error) {
    // No repository is a valid chat workspace; a Git repository with an unreadable diff is not.
    const { git } = await import("./changeset.js");
    try { await git(cwd, ["rev-parse", "--show-toplevel"]); } catch { return reply; }
    // Never expose child-process messages/stdout/stderr: they can contain source or credentials.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    const known = error instanceof Error && [
      "Changeset exceeds review size limit", "Invalid changeset path",
      "Untracked non-regular file requires operator review", "Untracked binary file requires operator review",
      "Untracked invalid UTF-8 file requires operator review",
    ].includes(error.message) ? error.message : undefined;
    const reason = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
      ? "ERR_CHILD_PROCESS_STDIO_MAXBUFFER: changeset exceeds review size limit (512 KiB)"
      : known ?? "Git/state capture failed; inspect local operator diagnostics";
    throw new Error(`Cannot establish review changeset; completion blocked: ${reason}`);
  }
  if (!requiresReview(change, service.config)) return reply;
  for (let n = 0; n <= service.config.maxTurns; n++) {
    if (signal?.aborted) throw new Error("Review cancelled");
    let state = await service.status(cwd);
    if (state.status === "passed" && state.approvedFingerprint === change.fingerprint) return reply;
    if (state.status !== "escalated") {
      const last = state.rounds.at(-1);
      if (last?.findings?.length && last.assessment.length !== last.findings.length) {
        reply = await session.prompt(`Critically assess the latest review findings via plugin_review action=assess, with concrete evidence for each. Fix confirmed defects. Do not dismiss P0/P1 without proof. Do not publish or merge.\n${JSON.stringify(state)}`, options);
      }
      if (signal?.aborted) throw new Error("Review cancelled");
      state = await service.run(cwd, input.sessionKey, signal);
    }
    if (state.status === "escalated") return `${reply}\n\n⚠️ Review blocked: budget exhausted; operator escalation required.\n${JSON.stringify(state)}`;
    if (state.status === "passed") {
      const last = state.rounds.at(-1);
      if (last?.findings?.length) {
        reply = await session.prompt(`Review passed with nonblocking findings. Critically assess and document each via plugin_review action=assess. P2/P3 do not block. If you edit code, it needs a fresh review.\n${JSON.stringify(state)}`, options);
      }
      try { await service.assertAllowed(cwd, "local"); return reply; } catch { /* changed during assessment */ }
    }
    change = await service.changes(cwd);
  }
  await service.requireOperator(cwd, input.sessionKey, "Review did not converge; completion blocked, operator intervention required");
  throw new Error("Review did not converge; completion blocked, operator intervention required");
}
