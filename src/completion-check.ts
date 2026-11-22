import type { Inbound } from "./types.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";
import type { CompletionAuthorization, CompletionPrompt, CompletionDiagnosticSink } from "./validator.js";
import { ValidatorRegistry, completionFailureDetail } from "./validator.js";
import { renderCompletionPrompt } from "./completion-budget.js";
import { createHash } from "node:crypto";
import { assessCompletion as validate, legacyLLMProvider } from "./builtin-plugins/completion-validator-plugin.js";
export type { CompletionAuthorization, CompletionDiagnostic, CompletionDiagnosticSink, CompletionPrompt } from "./validator.js";

/** Same bounded allowance as a real Dispatcher step: queue/prefill/reasoning can
 * exceed30s on the explicitly configured model. Explicit operator limits win. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 120000;
export function completionTimeout(configured?: number): number { return configured ?? DEFAULT_COMPLETION_TIMEOUT_MS; }
/** Non-authorizing policy identity: changed provider/budget permits ONE fresh
 * read-only assessment, not effect replay or reset of productive budgets. */
export function assessmentPolicyStamp(registry?: ValidatorRegistry, settings?: unknown, timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS): string | undefined {
  let p; try { p = registry?.current; } catch { return; } if (!p) return;
  return `assessment-boundary-v4:${createHash("sha256").update(JSON.stringify([p.name, p.version, p.maxPromptBytes ?? 56000, p.maxAuthorityPromptBytes, timeoutMs, settings])).digest("hex")}`;
}

/** Model judge used once when a non-model classifier answers "uncertain". */
export interface CompletionCrossCheck { backend: ReviewBackend; model?: string }

/** Compatibility entry point. Host authority and ownership fences remain outside providers.
 * Plugin results are advisory; execution/worker precedence is enforced by existing callers.
 * Embedders must supply an explicitly selected registry; there is no implicit cloud provider.
 */
export async function assessCompletion(backend: ReviewBackend, input: Inbound, reply: string,
  authorization: CompletionAuthorization | undefined, signal: AbortSignal,
  model: string | undefined = undefined, now = Date.now, promptStrategy?: CompletionPrompt,
  diagnostic?: CompletionDiagnosticSink, timeoutMs = 10000, registry?: ValidatorRegistry,
  crossCheck?: () => Promise<CompletionCrossCheck | undefined>): Promise<NonNullable<Inbound["continuation"]> | undefined> {
  const checkpoint = input.continuation;
  const permitted = () => input.source !== "api" &&
    (input.sessionKey !== "improvement:nightly" || authorization?.purpose === "nightly-closure") &&
    !signal.aborted && !!authorization?.task.trim() &&
    (authorization.expiresAt === undefined || (Number.isSafeInteger(authorization.expiresAt) && authorization.expiresAt > now())) &&
    input.continuation === checkpoint;
  if (!permitted()) { diagnostic?.("unavailable"); return; }
  if (!registry) throw Error("Completion-check provider registry is required; no implicit validator fallback");
  const provider = registry.current;
  if (!provider || !promptStrategy) { diagnostic?.("unavailable"); return; }
  let prompt: string | undefined;
  try {
    prompt = renderCompletionPrompt(promptStrategy, input, reply, authorization!, now, provider.maxPromptBytes);
    // A provider's declared bound remains hard unless its trusted binding
    // explicitly opts into a larger authority budget backed by its transport.
    // Authority is never shortened; optional evidence is still projected.
    if (prompt === undefined && provider.maxAuthorityPromptBytes !== undefined)
      prompt = renderCompletionPrompt(promptStrategy, input, reply, authorization!, now, provider.maxAuthorityPromptBytes);
  }
  catch { diagnostic?.("unavailable"); return; }
  if (prompt === undefined) { diagnostic?.("unavailable"); return; }
  const execute = async () => {
    if (!permitted()) { diagnostic?.("unavailable"); return; }
    // The execution timeout belongs to actual provider work, NOT time spent
    // queued behind already-running workers for shared host model capacity.
    let uncertainty: ReturnType<typeof completionFailureDetail>;
    const observed = { ...provider, async assess(request: Parameters<typeof provider.assess>[0]) {
      const result = await provider.assess(request);
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const answer = result as Record<string, unknown>;
        if (answer.state === "uncertain") uncertainty = completionFailureDetail({ cause: "uncertain", reason: answer.reason ?? answer.next ?? "Provider returned uncertainty without a rationale." });
      }
      return result;
    } };
    return validate(backend, input, reply, authorization, signal, model, now, promptStrategy,
      (category, detail) => diagnostic?.(category, category === "inconclusive" ? uncertainty : detail), timeoutMs, observed, prompt);
  };
  // A classifier below its confidence floor is not a semantic blocker. When a
  // model judge is configured, it decides once on the SAME exact authority and
  // evidence instead of handing a routine verdict to Main as a question.
  const original = diagnostic;
  let held: [Parameters<CompletionDiagnosticSink>[0], Parameters<CompletionDiagnosticSink>[1]] | undefined;
  const classifier = provider.requiresModel === false && !!crossCheck;
  if (classifier) diagnostic = (category, detail) => { held = [category, detail]; };
  let result;
  try { result = provider.requiresModel !== false && backend.admit ? await backend.admit(execute, signal) : await execute(); }
  catch { held = undefined; original?.(signal.aborted ? "unavailable" : "technical"); return; }
  diagnostic = original;
  if (classifier && !result && held?.[0] === "inconclusive" && permitted()) {
    let judge: CompletionCrossCheck | undefined;
    try { judge = await crossCheck!(); } catch { judge = undefined; }
    // Reuse the frozen classifier prompt, including its evidence projection and
    // timestamp. Re-rendering could change authority/evidence between judges.
    if (judge?.model) {
      const run = () => validate(judge!.backend, input, reply, authorization, signal, judge!.model, now, promptStrategy,
        (category, detail) => original?.(category, category === "inconclusive" ? held![1] ?? detail : detail), timeoutMs, legacyLLMProvider, prompt);
      try { result = judge.backend.admit ? await judge.backend.admit(run, signal) : await run(); }
      catch { original?.(signal.aborted ? "unavailable" : "technical"); return; }
      return permitted() ? result : undefined;
    }
  }
  if (held) original?.(held[0], held[1]);
  return permitted() ? result : undefined;
}
