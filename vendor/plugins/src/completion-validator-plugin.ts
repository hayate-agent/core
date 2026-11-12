import type { Inbound } from "./types.js";
import type { AssessmentBackend as ReviewBackend } from "./assessment-backend.js";
import type { CompletionAuthorization, CompletionDiagnostic, CompletionPrompt, ValidatorProvider } from "./validator.js";
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

/** Additive safe projection: older hosts may accept only the category.
 * Never include exception messages, stacks, URLs, headers, prompts or responses. */
interface FailureDetail {
  cause: "timeout" | "provider_error" | "invalid_shape";
  code?: "ECONNRESET" | "ECONNREFUSED" | "ETIMEDOUT" | "ENOTFOUND" | "EAI_AGAIN" | "UND_ERR_CONNECT_TIMEOUT" | "UND_ERR_SOCKET";
  status?: number;
}
function providerFailure(error: unknown): FailureDetail {
  const detail: FailureDetail = { cause: "provider_error" };
  try {
    const value = error as { code?: unknown; status?: unknown } | undefined;
    const code = value?.code;
    const status = value?.status;
    if (typeof code === "string" && ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) detail.code = code as FailureDetail["code"];
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) detail.status = status;
  } catch { /* exception properties may be hostile getters */ }
  return detail;
}

/** Classifier output is advisory. The caller must recheck cancellation, pause,
 * queue ownership and authorization before committing a continuation.
 */
export async function assessCompletion(backend: ReviewBackend, input: Inbound, reply: string,
  authorization: CompletionAuthorization | undefined, signal: AbortSignal,
  model: string | undefined = undefined, now = Date.now, promptStrategy?: CompletionPrompt, diagnostic?: (category: CompletionDiagnostic, detail?: FailureDetail) => void, timeoutMs = 10000, provider: ValidatorProvider = legacyLLMProvider, prompt?: string): Promise<NonNullable<Inbound["continuation"]> | undefined> {
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
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
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
    if (!result || typeof result !== "object" || Array.isArray(result)) { diagnostic?.(failure, { cause: "invalid_shape" }); return; }
    const answer = result as Record<string, any>;
    if (answer?.state === "uncertain") { diagnostic?.("inconclusive"); return; }
    const progress = answer?.progress && typeof answer.progress.advanced === "boolean" &&
      typeof answer.progress.fingerprint === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 ._:/-]{0,199}$/.test(answer.progress.fingerprint)
      ? { advanced: answer.progress.advanced, fingerprint: answer.progress.fingerprint } : undefined;
    if (["completed", "waiting", "blocked"].includes(answer.state)) return { state: answer.state, ...(progress ? { progress } : {}) };
    if (answer.state !== "continue" || typeof answer.next !== "string" || !answer.next.trim() || answer.next.length > 4000) { diagnostic?.(failure, { cause: "invalid_shape" }); return; }
    if (answer.contextPreparation !== undefined && !["compact", "handover"].includes(answer.contextPreparation)) { diagnostic?.(failure, { cause: "invalid_shape" }); return; }
    return { state: "continue", next: answer.next.trim(), ...(progress ? { progress } : {}), ...(answer.contextPreparation ? { contextPreparation: answer.contextPreparation } : {}), ...(authorization.expiresAt !== undefined ? { expiresAt: authorization.expiresAt } : {}) };
  } catch (error) {
    // Cancellation/expiry is not a provider fault, and never grants follow-up.
    if (signal.aborted || (grantLimited && timedOut) || (authorization.expiresAt !== undefined && authorization.expiresAt <= now())) diagnostic?.("unavailable");
    else diagnostic?.(failure, timedOut ? { cause: "timeout" } : failure === "invalid_response" ? { cause: "invalid_shape" } : providerFailure(error));
    return undefined;
  }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
