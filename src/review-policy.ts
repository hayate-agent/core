import type { Policy } from "./policies.js";
import type { ReviewService } from "./review.js";
import type { Address, Inbound } from "./types.js";
import { guardReviewTool } from "./review-guard.js";
import { finishWithReview } from "./review-lifecycle.js";

/** Default composition adapter; the engine and its durable ledger remain unchanged. */
export function reviewPolicy(service: ReviewService, origin: (input: Inbound) => Address | undefined): Policy {
  return {
    id: "review",
    prepare: (cwd, input) => service.prepare(cwd, origin(input), input.sessionKey),
    beforeTool: (cwd, tool, input) => guardReviewTool(service, cwd, tool, input),
    finish: (cwd, input, reply, session, options, signal) => finishWithReview(service, cwd, input, reply, session, options, signal),
    assertAllowed: (cwd, action) => service.assertAllowed(cwd, action),
  };
}
