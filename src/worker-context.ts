import { childDeniedTools } from "./child-tools.js";

/** Trigger native between-assistant-response compaction, not just Harness-turn
 * maintenance. A worker may make hundreds of provider requests in one turn. */
export function workerCompactionSettings(sessionKey: string, contextWindow: number | undefined,
  current: { reserveTokens: number; keepRecentTokens: number }, maxContextTokens = 131072) {
  if (!childDeniedTools(sessionKey).length || !Number.isSafeInteger(contextWindow) || contextWindow! <= 0) return;
  if (!Number.isSafeInteger(maxContextTokens) || maxContextTokens < 8192) throw Error("Invalid worker context token budget");
  return contextCompactionSettings(contextWindow!, current, maxContextTokens);
}

/** Operator context budget, separate from the model's actual physical window. */
export function contextCompactionSettings(contextWindow: number,
  current: { reserveTokens: number; keepRecentTokens: number }, maxContextTokens: number) {
  const window = contextWindow;
  // Retain an already stricter per-model setting; never enlarge native input.
  const reserveTokens = Math.max(current.reserveTokens, window - maxContextTokens);
  const threshold = Math.max(0, window - reserveTokens);
  return { enabled: true, reserveTokens, keepRecentTokens: Math.min(current.keepRecentTokens, Math.floor(threshold / 3)) };
}
