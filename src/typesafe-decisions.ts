import type { PluginModule } from "./plugins.js";
import type { ValidatorProvider } from "./validator.js";
import { typeSafeDecisionPlugin as pinnedDecisions } from "./builtin-plugins/typesafe-decision-plugin.js";
import { TYPESAFE_STATE_BYTES, TYPESAFE_API_SERVICE, createTypeSafeAPI, type TypeSafeAPI, type TypeSafeAPIConfig } from "./builtin-plugins/typesafe-api-plugin.js";
export { TYPESAFE_VALIDATOR, TYPESAFE_DISPATCHER, COMPLETION_BANK, DISPATCH_BANK, READY_BANK } from "./builtin-plugins/typesafe-decision-plugin.js";

/** Core compatibility binding for the pinned TypeSafe adapters. Their routine
 * prefill budget is smaller than the shared transport's verified hard ceiling.
 * Opt in here, not by provider name or a global assumption about custom plugins.
 * The generated plugin source and immutable lock remain unchanged. */
export const typeSafeDecisionPlugin: PluginModule = { apiVersion: 1, activate(host) {
  const bounded = (provider: ValidatorProvider): ValidatorProvider => ({ ...provider, maxAuthorityPromptBytes: TYPESAFE_STATE_BYTES });
  return pinnedDecisions.activate({ ...host,
    registerValidatorProvider: provider => host.registerValidatorProvider(bounded(provider)),
    registerDispatchDecisionProvider: provider => host.registerDispatchDecisionProvider(bounded(provider)),
  });
} };

/** Operator-tunable classifier floor. The pinned transport rejects every answer
 * below a hardcoded 0.9 as "unknown", which on real Paperclip reports turned
 * well-supported 0.75-0.89 verdicts into Main questions. Core re-admits a
 * transport-validated answer at or above this floor. Below it the answer stays
 * "uncertain", and the configured model validator cross-checks once. */
export const DEFAULT_TYPESAFE_MIN_CONFIDENCE = 0.8;
export function typeSafeMinConfidence(value: unknown): number {
  if (value === undefined) return DEFAULT_TYPESAFE_MIN_CONFIDENCE;
  // The pinned transport already enforces 0.9 for accepted answers and exposes
  // confidence only for rejected ones, so a floor can only be relaxed, not raised.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.5 || value > 0.9) throw Error("typeSafeDecisions.minConfidence must be between 0.5 and 0.9");
  return value;
}
export function createTypeSafeAPIPlugin(config: TypeSafeAPIConfig & { minConfidence?: number }): PluginModule {
  const { minConfidence, ...transport } = config;
  const floor = typeSafeMinConfidence(minConfidence);
  const wire = createTypeSafeAPI(transport);
  const api: TypeSafeAPI = { async choose(bank, state, signal, failure, uncertainty) {
    let low: { choice: string; confidence: number } | undefined;
    const choice = await wire.choose(bank, state, signal, failure, detail => {
      if (detail?.reason === "low_confidence") low = { choice: detail.choice, confidence: detail.confidence };
      else uncertainty?.(detail);
    });
    // Only a fully transport-validated choice (schema, bank, probabilities) that
    // the pinned floor alone rejected is re-admitted; never "unknown"/"none".
    if (choice === "unknown" && low && low.choice !== "unknown" && low.choice !== "none" && Object.hasOwn(bank.choices, low.choice) &&
        low.confidence >= floor && !signal.aborted) return low.choice;
    if (low) uncertainty?.({ reason: "low_confidence", ...low });
    return choice;
  } };
  return { apiVersion: 1, activate(host) { host.registerService(TYPESAFE_API_SERVICE, 1, api); } };
}
