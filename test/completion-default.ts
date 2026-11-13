import { assessCompletion as assess } from "./completion-selected.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
/** Exercise the production host guard with the separately owned default strategy. */
export const assessCompletion: typeof assess = (backend, input, reply, authorization, signal, model, now, prompt = completionPrompt, diagnostic, timeoutMs, registry) =>
  assess(backend, input, reply, authorization, signal, model, now, prompt, diagnostic, timeoutMs, registry);
