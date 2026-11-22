import { isBoundedReadResult } from "./bounded-read-result.js";

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
  details?: unknown;
  content?: unknown;
}

export type ToolResultProjector = <T extends ProjectionMessage>(messages: T[], policy: PruningPolicy) => T[];

/** Apply advisory strategies only to each result at its own prefix boundary.
 * Future suffixes must never change historical projection. Age-based keepRecent
 * is intentionally replaced by immediate projection after the prefix budget.
 * Ignore strategy edits to other messages/metadata; native evidence owns those. */
export function projectToolResultPrefixes<T extends ProjectionMessage>(messages: T[], policy: PruningPolicy, project: ToolResultProjector): T[] {
  if (!policy.enabled) return messages;
  let bytes = 0, projected = messages;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== "toolResult" || !Array.isArray(message.content) || message.content.some(part =>
      !part || part.type !== "text" || typeof part.text !== "string")) continue;
    const text = message.content.map(part => part.text).join("\n");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes < policy.proactivePruneTokens * 4 || text.length < policy.minResultChars || message.isError || isBoundedReadResult(message)) continue;
    // Existing strategy implementations support a zero protected suffix. This
    // is internal only; public policy validation still requires keepRecent >= 1.
    const result = project(messages.slice(0, i + 1), { ...policy, keepRecent: 0 })[i];
    if (!result || result === message || !Array.isArray(result.content) || result.content.some(part =>
      !part || part.type !== "text" || typeof part.text !== "string")) continue;
    if (JSON.stringify(result.content) === JSON.stringify(message.content)) continue;
    if (projected === messages) projected = [...messages];
    projected[i] = { ...message, content: result.content };
  }
  return projected;
}
