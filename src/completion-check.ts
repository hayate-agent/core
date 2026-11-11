import type { Inbound } from "./types.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";
import type { CompletionAuthorization, CompletionPrompt, CompletionDiagnosticSink } from "./validator.js";
import { ValidatorRegistry } from "./validator.js";
import { renderCompletionPrompt } from "./completion-budget.js";
import { assessCompletion as validate, legacyLLMProvider } from "./builtin-plugins/completion-validator-plugin.js";
export type { CompletionAuthorization, CompletionDiagnostic, CompletionDiagnosticSink, CompletionPrompt } from "./validator.js";

/** Compatibility entry point. Host authority and ownership fences remain outside providers.
 * Plugin results are advisory; execution/worker precedence is enforced by existing callers.
 * With no registry, use the shipped legacy provider (existing embedding/test API).
 */
export async function assessCompletion(backend: ReviewBackend, input: Inbound, reply: string,
  authorization: CompletionAuthorization | undefined, signal: AbortSignal,
  model: string | undefined = undefined, now = Date.now, promptStrategy?: CompletionPrompt,
  diagnostic?: CompletionDiagnosticSink, timeoutMs = 10000, registry?: ValidatorRegistry): Promise<NonNullable<Inbound["continuation"]> | undefined> {
  const checkpoint = input.continuation;
  const permitted = () => input.source !== "api" &&
    (input.sessionKey !== "improvement:nightly" || authorization?.purpose === "nightly-closure") &&
    !signal.aborted && !!authorization?.task.trim() &&
    (authorization.expiresAt === undefined || (Number.isSafeInteger(authorization.expiresAt) && authorization.expiresAt > now())) &&
    input.continuation === checkpoint;
  const provider = registry ? registry.current : legacyLLMProvider;
  if (!permitted() || !provider || !promptStrategy) { diagnostic?.("unavailable"); return; }
  let prompt: string | undefined;
  try { prompt = renderCompletionPrompt(promptStrategy, input, reply, authorization!, now); }
  catch { diagnostic?.("unavailable"); return; }
  if (prompt === undefined) { diagnostic?.("unavailable"); return; }
  const result = await validate(backend, input, reply, authorization, signal, model, now, promptStrategy, diagnostic, timeoutMs, provider, prompt);
  return permitted() ? result : undefined;
}
