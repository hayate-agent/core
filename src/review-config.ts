import type { ReviewConfig } from "./config.js";

export function reviewConfig(input?: Partial<Omit<ReviewConfig, "mandatory">> & { mandatory?: Partial<ReviewConfig["mandatory"]> }): ReviewConfig {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("Invalid review configuration");
  if (input?.mandatory !== undefined && (!input.mandatory || typeof input.mandatory !== "object" || Array.isArray(input.mandatory))) throw new Error("Invalid review.mandatory");
  const result: ReviewConfig = {
    enabled: input?.enabled ?? true,
    model: input?.model,
    thinking: input?.thinking ?? "medium",
    maxTurns: input?.maxTurns ?? 3,
    mandatory: { local: true, publish: true, merge: true, ...input?.mandatory },
    baseRef: input?.baseRef,
  };
  if (typeof result.enabled !== "boolean" || !Number.isSafeInteger(result.maxTurns) || result.maxTurns < 1 || result.maxTurns > 20 ||
      !["off", "minimal", "low", "medium", "high", "xhigh"].includes(result.thinking) ||
      (result.model !== undefined && (typeof result.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(result.model))) ||
      (result.baseRef !== undefined && (typeof result.baseRef !== "string" || !result.baseRef.trim() || result.baseRef.startsWith("-"))) ||
      !result.mandatory || Object.values(result.mandatory).some((v) => typeof v !== "boolean")) throw new Error("Invalid review configuration");
  return result;
}
