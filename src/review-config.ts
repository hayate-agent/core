import type { ReviewConfig } from "./config.js";

export function reviewConfig(input?: Partial<Omit<ReviewConfig, "mandatory" | "scope">> & { mandatory?: Partial<ReviewConfig["mandatory"]>; scope?: Partial<ReviewConfig["scope"]> }): ReviewConfig {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("Invalid review configuration");
  if (input?.mandatory !== undefined && (!input.mandatory || typeof input.mandatory !== "object" || Array.isArray(input.mandatory))) throw new Error("Invalid review.mandatory");
  const result: ReviewConfig = {
    enabled: input?.enabled ?? false,
    shellGuard: input?.shellGuard ?? false,
    scope: { mode: "risk", nonBlockingPaths: ["docs/**", "**/*.md", "**/*.txt"], requiredPaths: [".github/**", ".gitlab-ci.yml", "deploy/**", "**/SKILL.md", "**/AGENTS.md", "**/SOUL.md"], ...input?.scope },
    model: input?.model,
    thinking: input?.thinking ?? "medium",
    maxTurns: input?.maxTurns ?? 3,
    mandatory: { local: false, publish: false, merge: false, ...input?.mandatory },
    baseRef: input?.baseRef,
  };
  if (typeof result.shellGuard !== "boolean" || !["risk", "all"].includes(result.scope.mode) ||
      [result.scope.nonBlockingPaths, result.scope.requiredPaths].some((patterns) => !Array.isArray(patterns) || patterns.some((p) => typeof p !== "string" || !p.trim())) ||
      typeof result.enabled !== "boolean" || !Number.isSafeInteger(result.maxTurns) || result.maxTurns < 1 || result.maxTurns > 20 ||
      !["off", "minimal", "low", "medium", "high", "xhigh"].includes(result.thinking) ||
      (result.model !== undefined && (typeof result.model !== "string" || !/^[^/\s]+\/[^\s]+$/.test(result.model))) ||
      (result.baseRef !== undefined && (typeof result.baseRef !== "string" || !result.baseRef.trim() || result.baseRef.startsWith("-"))) ||
      !result.mandatory || Object.values(result.mandatory).some((v) => typeof v !== "boolean")) throw new Error("Invalid review configuration");
  return result;
}
