import type { DedicatedReviewExecution } from "./review-executor.js";
import { ReviewService } from "./review.js";
import { reviewPolicy } from "./review-policy.js";
import { reviewPlugin } from "./review-plugin.js";
import type { ReviewConfig } from "./config.js";
import type { AssessmentBackend } from "./assessment-backend.js";
import type { Address, Inbound } from "./types.js";

/** Bundled default selection belongs to the plugin, not the host composition root. */
export function createReviewEngine(context: {
  home: string; cwd: string; cwdFor?: (key: string) => string; config: ReviewConfig; backend: AssessmentBackend;
  reviewExecution?: DedicatedReviewExecution;
  notify(sessionKey: string, message: string, origin?: Address): Promise<void>;
  origin(input: Inbound): Address | undefined;
}) {
  const service = new ReviewService(context.home, context.config, context.backend, context.notify, context.reviewExecution);
  return {
    policies: context.config.enabled ? [reviewPolicy(service, context.origin)] : [],
    plugins: context.config.enabled ? [reviewPlugin(service, context.cwd, context.cwdFor)] : [],
    required: context.config.enabled ? ["review"] : [],
    instructions: context.config.enabled ? `Configured review capability: ${JSON.stringify({ mandatory: context.config.mandatory, shellGuard: context.config.shellGuard, scope: context.config.scope, maxTurns: context.config.maxTurns })}. plugin_review provides changeset inspection, review and assessment.` : "",
  };
}
/** Explicit capability marker: older pinned adapters must not claim correct cwd binding. */
createReviewEngine.executionContexts = 1 as const;
