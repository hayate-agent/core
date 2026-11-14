/** Admission bound for the final PI message projection, NOT a tokenizer or disk
 * retention policy. UTF-8 JSON bytes plus framing conservatively count normal
 * text, tool declarations/arguments and inline image data. Provider templates,
 * image token expansion and payload-hook rewrites are not tokenizer-accounted.
 * No messages are removed or changed: oversized evidence fails closed instead
 * of silently losing authority, unfinished effects or one half of a tool pair.
 * Exact provider token accounting remains provider-specific. */
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
