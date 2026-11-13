import type { HarnessConfig } from "./config.js";

/** Profile compatibility is NOT fallback after selecting a provider.
 * Older valid profiles omitted the entire optional block and used legacy-llm.
 * An explicit block must now name its provider (or false); missing/unknown
 * selected providers remain unavailable and never cause a network fallback.
 * Embedding callers/ValidatorRegistry keep the stricter explicit-selection API. */
export function completionProviderForProfile(config: Pick<HarnessConfig, "completionCheck">): string | false | undefined {
  return config.completionCheck === undefined ? "legacy-llm" : config.completionCheck.provider;
}
