import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import type { Context } from "@earendil-works/pi-ai";
import type { ModelPair } from "./model-roles.js";

/** Physical, normal-auth preflight only; no session or provider registration. */
export async function resolveHttpAssessment(runtime: ModelRuntime, pair: ModelPair, signal: AbortSignal) {
  if (!pair.model) return;
  const slash = pair.model.indexOf("/");
  if (slash <= 0) return;
  const model = runtime.getPhysicalModel(pair.model.slice(0, slash), pair.model.slice(slash + 1));
  if (!model || !["anthropic-messages", "openai-responses", "openai-completions"].includes(model.api)) return;
  const thinking = pair.thinking ?? "off";
  if (!getSupportedThinkingLevels(model).includes(thinking as never)) return;
  if (!await runtime.getAuth(model, { signal })) return;
  return { model, actual: { model: pair.model, thinking } };
}

/** One SDK HTTP attempt. Caller owns consumption, persistence and any fallback. */
export async function assessmentHttpAttempt(runtime: ModelRuntime,
  selected: NonNullable<Awaited<ReturnType<typeof resolveHttpAssessment>>>, context: Context,
  signal: AbortSignal, check: () => void, transport: typeof fetch = globalThis.fetch) {
  let attempts = 0;
  let rejected = false;
  const intercepted: typeof fetch = async (input, init) => {
    check();
    if (++attempts !== 1) throw Error("Assessment multiple HTTP attempts");
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const endpoint = selected.model.api === "anthropic-messages" ? "/messages"
      : selected.model.api === "openai-responses" ? "/responses" : "/chat/completions";
    if (method.toUpperCase() !== "POST" || !url.pathname.endsWith(endpoint)) throw Error("Unsupported assessment HTTP endpoint");
    const response = await transport(input, { ...init, redirect: "error", signal });
    if (response.status !== 429) return response;
    const reader = response.body?.getReader();
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024 * 1024) { await reader.cancel(); throw Error("Rejection too large"); }
        }
      } finally { reader.releaseLock(); }
    }
    check();
    rejected = true;
    return new Response('{"error":{"message":"HTTP rejection"}}', {
      status: 429, headers: { "content-type": "application/json" },
    });
  };
  const result = await runtime.streamSimple(selected.model, context, {
    signal, reasoning: selected.actual.thinking as never, maxRetries: 0, fetch: intercepted,
  }).result();
  check();
  return { result, eligible: attempts === 1 && rejected && result.stopReason === "error" };
}
