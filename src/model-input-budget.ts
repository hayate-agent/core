/** Configured input-token ceiling and legacy diagnostic byte-size helpers.
 * modelInputEstimate returns UTF-8 JSON BYTES plus framing, not tokens. Its
 * historical name does not make it a tokenizer or production admission gate.
 * Never compare those bytes directly with token capacity to force compaction.
 * Native SDK/provider context accounting owns actual capacity enforcement;
 * no messages, authority or tool/result pairs are removed by these helpers. */
export const MAX_MODEL_INPUT_TOKENS = 131072;
export function modelInputEstimate(messages: readonly unknown[]): number {
  return messages.reduce<number>((total, message) => total + Buffer.byteLength(JSON.stringify(message), "utf8") + 32, 256);
}
export function modelInputLimit(configured: number, contextWindow: number, outputTokens: number): number {
  if (!Number.isSafeInteger(configured) || configured < 1) throw Error("Invalid model input budget");
  if (!Number.isSafeInteger(outputTokens) || outputTokens < 0) throw Error("Invalid model output budget");
  const budget = Math.min(MAX_MODEL_INPUT_TOKENS, configured);
  // Unknown physical capacity stays unknown; the host cap still applies.
  return Number.isSafeInteger(contextWindow) && contextWindow > 0
    ? Math.max(0, Math.min(budget, contextWindow - outputTokens)) : budget;
}
export function modelInputAdmission(messages: readonly unknown[], limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw Error("Invalid model input admission limit");
  const estimate = modelInputEstimate(messages);
  return { estimate, limit, admitted: estimate <= limit };
}
