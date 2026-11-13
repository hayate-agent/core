import type { Inbound } from "./types.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";
import type { CompletionAuthorization, CompletionPrompt, CompletionDiagnosticSink } from "./validator.js";
import { ValidatorRegistry } from "./validator.js";
import { renderCompletionPrompt } from "./completion-budget.js";
import { createHash } from "node:crypto";
import { assessCompletion as validate } from "./builtin-plugins/completion-validator-plugin.js";
export type { CompletionAuthorization, CompletionDiagnostic, CompletionDiagnosticSink, CompletionPrompt } from "./validator.js";

/** Same bounded allowance as a real Dispatcher step: queue/prefill/reasoning can
 * exceed30s on the explicitly configured model. Explicit operator limits win. */
export const DEFAULT_COMPLETION_TIMEOUT_MS = 120000;
export function completionTimeout(configured?: number): number { return configured ?? DEFAULT_COMPLETION_TIMEOUT_MS; }
/** Non-authorizing policy identity: changed provider/budget permits ONE fresh
 * read-only assessment, not effect replay or reset of productive budgets. */
export function assessmentPolicyStamp(registry?: ValidatorRegistry, settings?: unknown, timeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS): string | undefined {
  let p; try { p = registry?.current; } catch { return; } if (!p) return;
  return `assessment-boundary-v2:${createHash("sha256").update(JSON.stringify([p.name, p.version, p.maxPromptBytes ?? 56000, timeoutMs, settings])).digest("hex")}`;
}

/** Compatibility entry point. Host authority and ownership fences remain outside providers.
 * Plugin results are advisory; execution/worker precedence is enforced by existing callers.
 * Embedders must supply an explicitly selected registry; there is no implicit cloud provider.
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
  if (!permitted()) { diagnostic?.("unavailable"); return; }
  if (!registry) throw Error("Completion-check provider registry is required; no implicit validator fallback");
  const provider = registry.current;
  if (!provider || !promptStrategy) { diagnostic?.("unavailable"); return; }
  let prompt: string | undefined;
  try { prompt = renderCompletionPrompt(promptStrategy, input, reply, authorization!, now, provider.maxPromptBytes); }
  catch { diagnostic?.("unavailable"); return; }
  if (prompt === undefined) { diagnostic?.("unavailable"); return; }
  const execute = async () => {
    if (!permitted()) { diagnostic?.("unavailable"); return; }
    // The execution timeout belongs to actual provider work, NOT time spent
    // queued behind already-running workers for shared host model capacity.
    return validate(backend, input, reply, authorization, signal, model, now, promptStrategy, diagnostic, timeoutMs, provider, prompt);
  };
  let result;
  try { result = provider.requiresModel !== false && backend.admit ? await backend.admit(execute, signal) : await execute(); }
  catch { diagnostic?.(signal.aborted ? "unavailable" : "technical"); return; }
  return permitted() ? result : undefined;
}
