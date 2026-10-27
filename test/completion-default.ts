import { assessCompletion as assess } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
/** Exercise the production host guard with the separately owned default strategy. */
export const assessCompletion: typeof assess = (backend, input, reply, authorization, signal, model, now, prompt = completionPrompt) =>
  assess(backend, input, reply, authorization, signal, model, now, prompt);
