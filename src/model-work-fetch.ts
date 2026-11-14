import { ModelWorkProof } from "./model-work-proof.js";
import { modelWorkRequestIdentity } from "./model-work-request.js";
import { localModelWorkHeaders } from "./model-work-class.js";

/** Public SDK transport hook: sign final serialized HTTP bytes, not a guessed
 * transcript. Existing body/auth/abort options and custom fetch stay unchanged.
 * Failed/unsupported signing downgrades scheduling; never blocks inference.
 */
export function modelWorkFetch(base: typeof fetch, proof: Promise<ModelWorkProof | undefined>,
  sessionKey: string, background: boolean, requested?: "interactive" | "background"): typeof fetch {
  return async (input, init) => {
    // Unknown streaming/custom Request transports stay untouched and unsigned.
    if (input instanceof Request) return base(input, init);
    const url = new URL(String(input)), method = (init?.method ?? "GET").toUpperCase();
    const classified: Record<string, string | null> = Object.fromEntries(new Headers(init?.headers));
    localModelWorkHeaders(classified, sessionKey, true, background, requested);
    const headers = new Headers();
    for (const [name, value] of Object.entries(classified)) if (value !== null) headers.set(name, value);
    if (headers.get("X-Hayate-Model-Work") === "interactive") {
      try {
        const key = await proof;
        if (key && method === "POST" && ["/v1/chat/completions", "/v1/completions", "/v1/responses"].includes(url.pathname) && !url.search) {
          // Never consume an unknown streaming body for scheduling priority.
          if (typeof init?.body !== "string") throw Error("Serialized scheduling body required");
          const { model, digest, oneToken } = modelWorkRequestIdentity(init.body);
          if (typeof model !== "string" || !/^[A-Za-z0-9_.:/-]{1,256}$/.test(model)) throw Error("Scheduling model required");
          // SDK cache warming reuses working transport with maxTokens:1.
          // Conservatively keep all one-token calls in the background lane.
          if (oneToken) headers.set("X-Hayate-Model-Work", "background");
          else {
            const signed: Record<string, string | null> = {};
            key.add(signed, method, url.pathname, digest, model);
            for (const [name, value] of Object.entries(signed)) if (value !== null) headers.set(name, value);
          }
        }
      } catch { /* Invalid/unsupported identity remains unsigned background at admission. */ }
    }
    return base(input, { ...init, headers });
  };
}
