import type { ValidatorProvider, ValidatorRequest } from "./validator.js";
import type { PluginModule } from "./plugins.js";

type Category = "completed" | "waiting" | "blocked" | "uncertain";
export interface TypeSafeConfig {
  /** Full /v1/systemone URL. No implicit cloud or endpoint discovery. */
  endpoint: string;
  model: string;
  questionbank: {
    id: string;
    instructions: string;
    choices: Record<string, { description: string; category: Category }>;
  };
  name?: string;
  timeoutMs?: number;
  minConfidence?: number;
  /** Explicit trusted provider, used only on technical transport failures. */
  fallback?: ValidatorProvider;
  /** Resolved locally by the operator; never included in diagnostics. */
  bearerToken?: string;
}
export type TypeSafeDiagnostic = "invalid_response" | "technical" | "timeout" | "cancelled" | "uncertain";
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const categories = ["completed", "waiting", "blocked", "uncertain"];
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max;

/** A factory for the open Core v1 contract, not a host-state or routing authority.
 * Only the host-budgeted prompt is exported, never raw input/authorization objects.
 */
export function createTypeSafeProvider(config: TypeSafeConfig,
  diagnostic?: (value: TypeSafeDiagnostic) => void): ValidatorProvider {
  const url = new URL(config.endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error("Invalid TypeSafe endpoint");
  const name = config.name ?? "typesafe";
  const timeoutMs = config.timeoutMs ?? 5000;
  const minConfidence = config.minConfidence ?? 0.9;
  const bank = structuredClone(config.questionbank);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(name) || !text(config.model, 200) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !probability(minConfidence) ||
      !bank || !text(bank.id, 100) || !text(bank.instructions, 8000) || !record(bank.choices) ||
      Object.keys(bank.choices).length < 2 || Object.keys(bank.choices).length > 255 ||
      !Object.entries(bank.choices).every(([id, c]) => /^[a-z][a-z0-9_-]{0,79}$/.test(id) && record(c) &&
        text(c.description, 4000) && categories.includes(c.category))) throw Error("Invalid TypeSafe configuration");
  if (!Object.values(bank.choices).some(c => c.category === "uncertain")) throw Error("Questionbank requires uncertain choice");
  const endpoint = url.href, model = config.model, token = config.bearerToken, fallback = config.fallback;
  function interpret(raw: unknown): { state: Category } | undefined {
    if (!record(raw) || Object.keys(raw).some(k => !["model", "answers", "usage"].includes(k)) ||
        !text(raw.model, 200) || !record(raw.answers) || !exact(raw.answers, [bank.id])) return;
    if (raw.usage !== undefined && (!record(raw.usage) || !exact(raw.usage, ["input_tokens", "output_tokens"]) ||
        !Object.values(raw.usage).every(v => Number.isSafeInteger(v) && (v as number) >= 0))) return;
    const answer = raw.answers[bank.id];
    if (!record(answer) || !exact(answer, ["type", "choice", "confidence", "probabilities"]) ||
        answer.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(bank.choices, answer.choice) ||
        !probability(answer.confidence) || !record(answer.probabilities) || !exact(answer.probabilities, Object.keys(bank.choices)) ||
        !Object.values(answer.probabilities).every(probability)) return;
    const values = Object.values(answer.probabilities) as number[];
    if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.02 ||
        (answer.probabilities[answer.choice] as number) < Math.max(...values)) return;
    const state = bank.choices[answer.choice].category;
    return { state: answer.confidence < minConfidence ? "uncertain" : state };
  }
  return { apiVersion: 1, name, version: 1,
    async assess(request: ValidatorRequest) {
      const controller = new AbortController();
      let reason: TypeSafeDiagnostic = "technical";
      let transportStatus: number | undefined;
      const reportFailure = (cause: "timeout" | "provider_error") => {
        (request as ValidatorRequest & { reportFailure?: (detail: unknown) => void }).reportFailure?.({ cause,
          ...(cause === "timeout" ? { code: "ETIMEDOUT" } : transportStatus !== undefined ? { status: transportStatus } : {}) });
      };
      let rejectStop: (error: Error) => void = () => {};
      const stopped = new Promise<never>((_, reject) => { rejectStop = reject; });
      const stop = (why: TypeSafeDiagnostic) => { reason = why; controller.abort(); rejectStop(Error("TypeSafe stopped")); };
      const abort = () => stop("cancelled");
      request.signal.addEventListener("abort", abort, { once: true });
      const remaining = request.authorization.expiresAt === undefined ? timeoutMs : Math.min(timeoutMs, request.authorization.expiresAt - request.now());
      const timer = setTimeout(() => stop("timeout"), Math.max(0, remaining));
      try {
        if (request.signal.aborted || remaining <= 0) { stop(request.signal.aborted ? "cancelled" : "timeout"); await stopped; }
        if (!text(request.promptText, 1000000)) { diagnostic?.("invalid_response"); return; }
        const operation = async () => {
          let raw: unknown;
          try {
            const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: controller.signal,
              headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
              body: JSON.stringify({ model, state: request.promptText, questions: { [bank.id]: {
                type: "choice", instructions: bank.instructions,
                criteria: Object.fromEntries(Object.entries(bank.choices).map(([id, c]) => [id, c.description])),
              } } }) });
            if (!response.ok) { if (response.status >= 400 && response.status <= 599) transportStatus = response.status; await response.body?.cancel(); throw Error("TypeSafe transport failure"); }
            // Bounded streaming body; timeout applies to headers, body and fallback together.
            const reader = response.body?.getReader();
            if (!reader) throw Error("Missing response body");
            const chunks: Uint8Array[] = []; let size = 0;
            try {
              while (true) {
                const { done, value } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > 65536) { await reader.cancel(); diagnostic?.("invalid_response"); return; }
                chunks.push(value);
              }
            } finally { reader.releaseLock(); }
            const bytes = new Uint8Array(size); let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
            try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
            catch { diagnostic?.("invalid_response"); return; }
          } catch {
            if (controller.signal.aborted) return;
            diagnostic?.("technical");
            if (fallback) return fallback.assess({ ...request, signal: controller.signal });
            reportFailure("provider_error");
            return;
          }
          const result = interpret(raw);
          if (!result) diagnostic?.("invalid_response");
          else if (result.state === "uncertain") diagnostic?.("uncertain");
          return result;
        };
        const result = await Promise.race([operation(), stopped]);
        if (controller.signal.aborted || request.signal.aborted ||
            (request.authorization.expiresAt !== undefined && request.authorization.expiresAt <= request.now())) return;
        return result;
      } catch {
        const stoppedReason = ((): TypeSafeDiagnostic => reason)();
        diagnostic?.(stoppedReason);
        if (!request.signal.aborted && stoppedReason !== "cancelled") reportFailure(stoppedReason === "timeout" ? "timeout" : "provider_error");
        return;
      }
      finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
    },
  };
}

/** Explicit operator-owned module configuration; registration does not select or activate usage. */
export function createTypeSafeValidatorPlugin(config: TypeSafeConfig): PluginModule {
  const provider = createTypeSafeProvider(config);
  return { apiVersion: 1, activate(api) { api.registerValidatorProvider(provider); } };
}
