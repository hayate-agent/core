// SPDX-License-Identifier: Apache-2.0
import type { AssessmentBackend } from "../src/assessment-backend.js";
import type { DedicatedReviewExecution } from "../src/review-execution.js";
/** Explicit mock transport for ledger/policy tests, not evidence of real isolation. */
export function testReviewExecution(backend: AssessmentBackend): DedicatedReviewExecution {
  return { dispatcherEnabled: () => true, dispatcherWorker: async request => ({
    kind: "dispatcher-worker", executionId: "mock-dedicated-review", isolated: true,
    fingerprint: request.fingerprint,
    result: await backend.review(request.prompt, request.model, request.thinking, request.signal),
  }) };
}
