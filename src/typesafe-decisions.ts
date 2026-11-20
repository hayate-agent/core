import type { PluginModule } from "./plugins.js";
import type { ValidatorProvider } from "./validator.js";
import { typeSafeDecisionPlugin as pinnedDecisions } from "./builtin-plugins/typesafe-decision-plugin.js";
import { TYPESAFE_STATE_BYTES } from "./builtin-plugins/typesafe-api-plugin.js";
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
