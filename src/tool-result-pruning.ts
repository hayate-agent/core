export interface PruningPolicy {
  enabled: boolean;
  /** Approximate tool-text budget, estimated conservatively from UTF-8 bytes / 4. */
  proactivePruneTokens: number;
  minResultChars: number;
  maxResultChars: number;
  keepRecent: number;
}
export function pruningPolicy(input: Partial<PruningPolicy> = {}): PruningPolicy {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid tool-result pruning policy");
  const policy = { enabled: true, proactivePruneTokens: 12000, minResultChars: 4000, maxResultChars: 2000, keepRecent: 6, ...input };
  if (Object.keys(input).some((key) => !Object.hasOwn(policy, key) || !["enabled", "proactivePruneTokens", "minResultChars", "maxResultChars", "keepRecent"].includes(key)) ||
      typeof policy.enabled !== "boolean" || [policy.proactivePruneTokens, policy.minResultChars, policy.maxResultChars, policy.keepRecent].some((v) => !Number.isSafeInteger(v) || v < 1) ||
      policy.maxResultChars < 256 || policy.minResultChars <= policy.maxResultChars) throw new Error("Invalid tool-result pruning policy");
  return policy;
}
export interface ProjectionMessage {
  role: string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  content?: unknown;
}

export type ToolResultProjector = <T extends ProjectionMessage>(messages: T[], policy: PruningPolicy) => T[];
