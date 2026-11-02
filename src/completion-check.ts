import type { Inbound } from "./types.js";
import { renderCompletionPrompt } from "./completion-budget.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";

export interface CompletionAuthorization {
  /** Trusted caller supplies the existing task boundary; never derive from reply. */
  task: string;
  expiresAt?: number;
}

/** Bounded host diagnostic only; never contains provider output or errors. */
export type CompletionDiagnostic = "unavailable" | "inconclusive" | "invalid_response" | "technical";
export type CompletionDiagnosticSink = (diagnostic: CompletionDiagnostic) => void;

export type CompletionPrompt = (input: Inbound, reply: string, authorization: CompletionAuthorization, now: () => number) => string;

/** Classifier output is advisory. The caller must recheck cancellation, pause,
 * queue ownership and authorization before committing a continuation.
 */
export async function assessCompletion(backend: ReviewBackend, input: Inbound, reply: string,
  authorization: CompletionAuthorization | undefined, signal: AbortSignal,
  model: string | undefined = undefined, now = Date.now, promptStrategy?: CompletionPrompt, diagnostic?: CompletionDiagnosticSink): Promise<NonNullable<Inbound["continuation"]> | undefined> {
  if (!promptStrategy) { diagnostic?.("unavailable"); return; }
  const checkpoint = input.continuation;
  if (input.source === "api" || input.sessionKey === "improvement:nightly" ||
      signal.aborted || !authorization ||
      !authorization.task.trim() ||
      (authorization.expiresAt !== undefined && (!Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= now()))) { diagnostic?.("unavailable"); return; }
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(Error("Completion assessment timed out")); }, 10000);
  });
  let failure: CompletionDiagnostic = "technical";
  try {
    let prompt: string | undefined;
    try { prompt = renderCompletionPrompt(promptStrategy, input, reply, authorization, now); }
    catch { diagnostic?.("unavailable"); return; }
    if (prompt === undefined) { diagnostic?.("unavailable"); return; }
    const raw = await Promise.race([backend.review(prompt, model, "low", controller.signal), timeout]);
    if (signal.aborted || controller.signal.aborted || (authorization.expiresAt !== undefined && authorization.expiresAt <= now()) || input.continuation !== checkpoint) return;
    failure = "invalid_response";
    if (raw.length > 8000) { diagnostic?.(failure); return; }
    const result = JSON.parse(raw);
    if (result?.state === "uncertain") { diagnostic?.("inconclusive"); return; }
    const progress = result?.progress && typeof result.progress.advanced === "boolean" &&
      typeof result.progress.fingerprint === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,199}$/.test(result.progress.fingerprint)
      ? { advanced: result.progress.advanced, fingerprint: result.progress.fingerprint } : undefined;
    if (["completed", "waiting", "blocked"].includes(result.state)) return { state: result.state, ...(progress ? { progress } : {}) };
    if (result.state !== "continue" || typeof result.next !== "string" || !result.next.trim() || result.next.length > 4000) { diagnostic?.(failure); return; }
    if (result.contextPreparation !== undefined && !["compact", "handover"].includes(result.contextPreparation)) { diagnostic?.(failure); return; }
    return { state: "continue", next: result.next.trim(), ...(progress ? { progress } : {}), ...(result.contextPreparation ? { contextPreparation: result.contextPreparation } : {}), ...(authorization.expiresAt !== undefined ? { expiresAt: authorization.expiresAt } : {}) };
  } catch { diagnostic?.(failure); return undefined; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
