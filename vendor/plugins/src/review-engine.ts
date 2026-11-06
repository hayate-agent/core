// SPDX-License-Identifier: Apache-2.0
import type { DedicatedReviewExecution } from "./review-executor.js";
import { ReviewService } from "./review.js";
import { reviewPolicy } from "./review-policy.js";
import { reviewPlugin } from "./review-plugin.js";
import type { ReviewConfig } from "./config.js";
import type { AssessmentBackend } from "./assessment-backend.js";
import type { Address, Inbound } from "./types.js";

/** Bundled default selection belongs to the plugin, not the host composition root. */
export function createReviewEngine(context: {
  home: string; cwd: string; config: ReviewConfig; backend: AssessmentBackend;
  reviewExecution?: DedicatedReviewExecution;
  notify(sessionKey: string, message: string, origin?: Address): Promise<void>;
  origin(input: Inbound): Address | undefined;
}) {
  const service = new ReviewService(context.home, context.config, context.backend, context.notify, context.reviewExecution);
  return {
    policies: context.config.enabled ? [reviewPolicy(service, context.origin)] : [],
    plugins: context.config.enabled ? [reviewPlugin(service, context.cwd)] : [],
    required: context.config.enabled ? ["review"] : [],
    instructions: context.config.enabled ? "Review is enabled. Use plugin_review to inspect, critically assess and review code changes. P0/P1 block publication and completion. Budget cannot be reset by starting another session." : "",
  };
}
