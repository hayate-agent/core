import type { PluginAPI, PluginModule } from "./plugins.js";
import type { ValidatorProvider, ValidatorRequest } from "./validator.js";
import { TYPESAFE_API_SERVICE, TYPESAFE_STATE_BYTES, type TypeSafeAPI } from "./typesafe-api-plugin.js";
import { COMPLETION_BANK, DISPATCH_BANK, READY_BANK } from "./typesafe-question-banks.js";
export { COMPLETION_BANK, DISPATCH_BANK, READY_BANK } from "./typesafe-question-banks.js";
export const TYPESAFE_VALIDATOR = "typesafe-completion";
export const TYPESAFE_DISPATCHER = "typesafe-dispatch";

/** Export only the already host-rendered, bounded assessment evidence, never the
 * backend, token, environment, entire request, or host authorization object.
 * Do not truncate authority/evidence to force a verdict. Sensitive/incomplete
 * exports fail closed. This is not a general-purpose DLP detector. */
export function decisionState(request: ValidatorRequest): string | undefined {
  const state = request.promptText;
  if (!state.trim() || Buffer.byteLength(state) > TYPESAFE_STATE_BYTES ||
      /(?:authorization\s*[=:]|bearer\s+[a-z0-9._~+\/-]+|(?:api[_-]?key|password|secret|token)\s*[=:]\s*\S+|-----BEGIN [^-]*PRIVATE KEY-----)/i.test(state)) return;
  return state;
}
// Keep routine evidence prefill bounded independently of the raw transport
// ceiling. Compatible hosts project optional observations; exact authority and
// expiry must still fit intact, otherwise assessment remains unavailable.
function adapter(host: PluginAPI, dispatcher: boolean): ValidatorProvider & { requiresModel: false; maxPromptBytes: number } {
  return { apiVersion: 1, version: 1, name: dispatcher ? TYPESAFE_DISPATCHER : TYPESAFE_VALIDATOR, requiresModel: false, maxPromptBytes: 24000,
    async assess(request) {
      const permitted = () => !request.signal.aborted && !!request.authorization.task.trim() &&
        (request.authorization.expiresAt === undefined || (Number.isSafeInteger(request.authorization.expiresAt) && request.authorization.expiresAt > request.now()));
      if (!permitted()) return;
      const state = decisionState(request);
      if (state === undefined) return;
      const service = host.services.get(TYPESAFE_API_SERVICE);
      if (service?.version !== 1 || typeof (service.implementation as TypeSafeAPI)?.choose !== "function") return;
      const ready = dispatcher && request.input.id?.startsWith("schedule:");
      // No cross-consumer bank selection from model/user prose.
      if (dispatcher && !ready && !request.input.id?.startsWith("validate:")) return;
      const bank = ready ? READY_BANK : dispatcher ? DISPATCH_BANK : COMPLETION_BANK;
      let transportFailure: { cause: string; status?: number } | undefined;
      let uncertainDetail: { reason: "low_confidence" | "model_uncertain"; choice: string; confidence: number } | undefined;
      const choice = await (service.implementation as TypeSafeAPI).choose(bank, state, request.signal, detail => {
        if (detail?.cause === "timeout" || detail?.cause === "provider_error") transportFailure = {
          cause: detail.cause,
          ...(Number.isInteger(detail.status) && detail.status! >= 400 && detail.status! <= 599 ? { status: detail.status } : {}),
        };
      }, detail => {
        if ((detail?.reason === "low_confidence" || detail?.reason === "model_uncertain") &&
            typeof detail.choice === "string" && Object.hasOwn(bank.choices, detail.choice) &&
            typeof detail.confidence === "number" && Number.isFinite(detail.confidence) && detail.confidence >= 0 && detail.confidence <= 1) uncertainDetail = detail;
      });
      if (!permitted()) return;
      if (transportFailure) {
        // Fixed public vocabulary only; no URL, response body, credential or
        // private exception text crosses the host diagnostic boundary.
        throw Object.assign(Error("TypeSafe transport unavailable"), transportFailure.cause === "timeout"
          ? { code: "ETIMEDOUT" } : transportFailure.status ? { status: transportFailure.status } : {});
      }
      if (!choice) return;
      if (choice === "unknown" || choice === "none") {
        const detail = uncertainDetail;
        return { state: "uncertain", reason: detail
          ? `TypeSafe ${detail.reason}; selected ${detail.choice}, confidence ${detail.confidence}. No textual rationale provided.`
          : "TypeSafe returned uncertainty without a textual rationale." };
      }
      if (ready) {
        const number = /^step_([1-6])$/.exec(choice)?.[1];
        return number ? { state: "continue", next: number } : undefined;
      }
      if (choice === "done") return { state: "completed" };
      if (choice === "waiting") return { state: "waiting" };
      if (choice === "blocked") return { state: "blocked" };
      if (choice === "more") return { state: "continue", next: "Reconcile the current report with the existing mandate and host evidence; finish only the already authorized unmet requirements. Do not replay settled effects or bypass required gates." };
      return;
    } };
}

export const typeSafeDecisionPlugin: PluginModule = { apiVersion: 1, activate(host) {
  // Resolve the transport only at assessment time, after ALL activations. Reverse
  // builtin/operator plugin order must not change registration or selection.
  const register = (host as PluginAPI & { registerDispatchDecisionProvider?: (provider: ValidatorProvider) => void }).registerDispatchDecisionProvider;
  if (!register) throw Error("TypeSafe Dispatcher decision host hook is required");
  host.registerValidatorProvider(adapter(host, false));
  register(adapter(host, true));
} };
