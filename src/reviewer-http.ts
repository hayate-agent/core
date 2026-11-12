import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { assessmentHttpAttempt, resolveHttpAssessment } from "./assessment-http.js";
import type { ReviewHttpContext } from "./builtin-plugins/review-executor.js";
import { createHash } from "node:crypto";

/** Dedicated code review only. Consumption belongs to the parent Round ledger. */
export async function reviewHttp(runtime: ModelRuntime, prompt: string, assessment: ReviewHttpContext,
  executionId: string, signal: AbortSignal, transport: typeof fetch = globalThis.fetch): Promise<string> {
  const check = () => { if (signal.aborted) throw Error("Review stopped"); };
  check();
  if (createHash("sha256").update(prompt).digest("hex") !== assessment.promptDigest || assessment.consumed()) {
    throw Error("Review assessment identity/consumption mismatch");
  }
  const first = await resolveHttpAssessment(runtime, assessment.requested, signal);
  if (!first) throw Error("Unsupported review HTTP selection");
  const fallback = await resolveHttpAssessment(runtime, assessment.defaults, signal).catch(() => undefined);
  const run = async (selected: NonNullable<typeof first>, phase: "initial" | "fallback") => {
    await assessment.persist({ phase, actual: selected.actual, executionId,
      ...(phase === "fallback" ? { initialRejected429: true as const } : {}) });
    check();
    return assessmentHttpAttempt(runtime, selected, {
      systemPrompt: "Review the supplied candidate only. Return review JSON. No actions or tools.",
      messages: [{ role: "user", content: prompt, timestamp: 0 }],
    }, signal, check, transport);
  };
  let selected = first;
  let outcome = await run(first, "initial");
  if (outcome.eligible && fallback && first.actual.model !== fallback.actual.model) {
    selected = fallback;
    outcome = await run(fallback, "fallback");
  }
  if (outcome.result.stopReason !== "stop" && !outcome.eligible) throw Error("Review HTTP outcome unknown");
  const result = outcome.result.stopReason === "stop"
    ? outcome.result.content.filter(c => c.type === "text").map(c => c.text).join("") : undefined;
  const valid = result !== undefined && result.length <= 64000 && result.length > 0;
  await assessment.persist({ phase: "observed", actual: selected.actual, executionId,
    ...(valid ? { result } : { terminal: outcome.eligible ? "rejected" as const : "invalid" as const }) });
  check();
  if (!valid) throw Error("Review HTTP returned no bounded result");
  return result;
}
