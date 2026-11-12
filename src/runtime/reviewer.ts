import { auxiliaryAdmission } from "../parallel-admission.js";
import type { AgentRuntime } from "../types.js";
import type { AssessmentBackend as ReviewBackend } from "../assessment-backend.js";

/** Shared by production wiring and live integration checks. */
export function runtimeReviewer(runtime: AgentRuntime, purpose: "code-review" | "supervisor" | "handover" = "code-review"): ReviewBackend {
  return {
    async review(prompt, model, thinking, signal) {
      return auxiliaryAdmission(runtime, async () => {
      const reviewer = await runtime.open(`review:${Date.now()}`, { ephemeral: true, assessmentPurpose: purpose });
      // Abort is best-effort; runtime failures must not escape the event callback as
      // unhandled rejections. Prompt/dispose errors still propagate to the review gate.
      const abort = () => { void Promise.resolve().then(() => reviewer.abort()).catch(() => undefined); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) throw new Error("Review cancelled");
        const result = await reviewer.prompt(prompt, { model, thinking });
        if (result.trim() || thinking === "off" || signal?.aborted) return result;
        // Reasoning-only local responses are not a review verdict. One bounded
        // retry with explicit wire-level reasoning disabled stays in this same
        // review attempt; parsing/gating still requires a real JSON verdict.
        return await reviewer.prompt(prompt, { model, thinking: "off" });
      } finally {
        signal?.removeEventListener("abort", abort);
        await reviewer.dispose();
      }
      }, signal);
    },
  };
}
