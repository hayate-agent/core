import { assessCompletion as assess } from "../src/completion-check.js";
import { ValidatorRegistry } from "../src/validator.js";
import { legacyLLMProvider } from "../src/builtin-plugins/completion-validator-plugin.js";
// Fixtures intentionally exercise the legacy backend, never an implicit production default.
export function legacyValidatorRegistry(): ValidatorRegistry {
  const registry = new ValidatorRegistry();
  registry.register(legacyLLMProvider);
  registry.select("legacy-llm");
  return registry;
}
const registry = legacyValidatorRegistry();
export const assessCompletion: typeof assess = (backend, input, reply, authorization, signal, model, now, prompt, diagnostic, timeoutMs, selected = registry) =>
  assess(backend, input, reply, authorization, signal, model, now, prompt, diagnostic, timeoutMs, selected);
