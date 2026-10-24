import type { AgentRuntime } from "../types.js";
import type { ReviewBackend } from "../review.js";

/** Shared by production wiring and live integration checks. */
export function runtimeReviewer(runtime: AgentRuntime): ReviewBackend {
  return {
    async review(prompt, model, thinking, signal) {
      const reviewer = await runtime.open(`review:${Date.now()}`, { ephemeral: true });
      const abort = () => { void reviewer.abort(); };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) throw new Error("Review cancelled");
        return await reviewer.prompt(prompt, { model, thinking });
      } finally {
        signal?.removeEventListener("abort", abort);
        await reviewer.dispose();
      }
    },
  };
}
