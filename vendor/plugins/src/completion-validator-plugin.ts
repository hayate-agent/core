import type { Inbound } from "./types.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";
import type { CompletionAuthorization, CompletionDiagnostic, CompletionDiagnosticSink, CompletionPrompt, ValidatorProvider } from "./validator.js";
import type { PluginModule } from "./plugins.js";

/** Existing LLM judge, now a replaceable concrete provider. No endpoint or model policy. */
export const legacyLLMProvider: ValidatorProvider = {
  apiVersion: 1, name: "legacy-llm", version: 1,
  async assess({ backend, signal, model, promptText }) {
    const raw = await backend.review(promptText, model, "low", signal);
    if (typeof raw !== "string" || raw.length > 8000) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  },
};

export const validatorPlugin: PluginModule = { apiVersion: 1,
  activate(api) { api.registerValidatorProvider(legacyLLMProvider); },
};

/** Classifier output is advisory. The caller must recheck cancellation, pause,
 * queue ownership and authorization before committing a continuation.
 */
export async function assessCompletion(backend: ReviewBackend, input: Inbound, reply: string,
  authorization: CompletionAuthorization | undefined, signal: AbortSignal,
  model: string | undefined = undefined, now = Date.now, promptStrategy?: CompletionPrompt, diagnostic?: CompletionDiagnosticSink, timeoutMs = 10000, provider: ValidatorProvider = legacyLLMProvider, prompt?: string): Promise<NonNullable<Inbound["continuation"]> | undefined> {
  if (!promptStrategy) { diagnostic?.("unavailable"); return; }
  const checkpoint = input.continuation;
  if (input.source === "api" || (input.sessionKey === "improvement:nightly" && authorization?.purpose !== "nightly-closure") ||
      signal.aborted || !authorization ||
      !authorization.task.trim() ||
      (authorization.expiresAt !== undefined && (!Number.isSafeInteger(authorization.expiresAt) || authorization.expiresAt <= now()))) { diagnostic?.("unavailable"); return; }
  const controller = new AbortController();
  const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const lifetime = authorization.expiresAt === undefined ? Infinity : Math.max(0, authorization.expiresAt - now());
  const grantLimited = lifetime <= timeoutMs;
  let failure: CompletionDiagnostic = "technical";
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (grantLimited) failure = "unavailable";
      controller.abort();
      reject(Error("Completion assessment timed out"));
    }, Math.min(timeoutMs, lifetime));
  });
  try {
    if (prompt === undefined) { diagnostic?.("unavailable"); return; }
    const result = await Promise.race([provider.assess({ backend, input, reply, authorization,
      signal: controller.signal, model, now, prompt: promptStrategy, promptText: prompt }), timeout]);
    if (signal.aborted || controller.signal.aborted || (authorization.expiresAt !== undefined && authorization.expiresAt <= now()) || input.continuation !== checkpoint) return;
    failure = "invalid_response";
    if (!result || typeof result !== "object" || Array.isArray(result)) { diagnostic?.(failure); return; }
    const answer = result as Record<string, any>;
    if (answer?.state === "uncertain") { diagnostic?.("inconclusive"); return; }
    const progress = answer?.progress && typeof answer.progress.advanced === "boolean" &&
      typeof answer.progress.fingerprint === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,199}$/.test(answer.progress.fingerprint)
      ? { advanced: answer.progress.advanced, fingerprint: answer.progress.fingerprint } : undefined;
    if (["completed", "waiting", "blocked"].includes(answer.state)) return { state: answer.state, ...(progress ? { progress } : {}) };
    if (answer.state !== "continue" || typeof answer.next !== "string" || !answer.next.trim() || answer.next.length > 4000) { diagnostic?.(failure); return; }
    if (answer.contextPreparation !== undefined && !["compact", "handover"].includes(answer.contextPreparation)) { diagnostic?.(failure); return; }
    return { state: "continue", next: answer.next.trim(), ...(progress ? { progress } : {}), ...(answer.contextPreparation ? { contextPreparation: answer.contextPreparation } : {}), ...(authorization.expiresAt !== undefined ? { expiresAt: authorization.expiresAt } : {}) };
  } catch { diagnostic?.(failure); return undefined; }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
