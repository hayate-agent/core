/** Per-task model routing rule: first matching rule wins; a rule with an empty match is the fallback. */
export interface DispatchModelRuleMatch {
  minChars?: number;
  maxChars?: number;
  keywords?: string[];
  regex?: string;
}
export interface DispatchModelRule {
  match?: DispatchModelRuleMatch;
  model: string;
  thinking?: string;
}
export interface DispatcherConfig {
  enabled: boolean;
  strategy: string;
  /** Independent decision provider; omission preserves legacy configurations. */
  decisionProvider?: string | false;
  /** Explicit operator declaration: the configured runtime/backend supports concurrency. */
  concurrentRequests: boolean;
  /** Active slots, not a limit on the number of persistent workers/tasks. */
  capacity: number;
  /** Share productive dispatcher slots with memory and validator model work. */
  countAuxiliaryRuns: boolean;
  /** Automatic archive age for delivered terminal task records. */
  retentionDays: number;
  /** Maximum total worker attempts (initial run + retries) per task before a manual-intervention hold. */
  workerRetryMax: number;
  /** Per-task model routing rules (first match wins; at most one empty-match fallback, last). */
  rules?: DispatchModelRule[];
  /** Operator-approved parallel agent swarm. Always proposed first; a swarm occupies ONE capacity slot. */
  swarm?: DispatcherSwarmConfig;
}
export interface DispatcherSwarmConfig {
  enabled: boolean;
  /** Members per swarm, bounded by the host subagent ceiling. */
  maxSize: number;
}
/** Same ceiling as concurrently active subagents; a swarm never exceeds it. */
export const SWARM_MEMBER_CEILING = 4;
export function swarmConfig(value: unknown): DispatcherSwarmConfig {
  if (value === undefined) return { enabled: false, maxSize: SWARM_MEMBER_CEILING };
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["enabled", "maxSize"].includes(key))) throw Error("Invalid dispatcher.swarm");
  const config = { enabled: false, maxSize: SWARM_MEMBER_CEILING, ...(value as Partial<DispatcherSwarmConfig>) };
  if (typeof config.enabled !== "boolean" || !Number.isSafeInteger(config.maxSize) || config.maxSize < 2 || config.maxSize > SWARM_MEMBER_CEILING)
    throw Error(`Invalid dispatcher.swarm (maxSize must be 2..${SWARM_MEMBER_CEILING})`);
  return config;
}
export function dispatcherConfig(value?: Partial<DispatcherConfig>): DispatcherConfig {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw Error("Invalid dispatcher configuration");
  const config = { enabled: false, strategy: "direct", concurrentRequests: false, capacity: 4, countAuxiliaryRuns: false, retentionDays: 7, workerRetryMax: 12, ...value };
  if (config.decisionProvider !== undefined && config.decisionProvider !== false && (typeof config.decisionProvider !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(config.decisionProvider))) throw Error("Invalid dispatcher.decisionProvider");
  if (typeof config.countAuxiliaryRuns !== "boolean" || typeof config.enabled !== "boolean" || typeof config.concurrentRequests !== "boolean" ||
      typeof config.strategy !== "string" || !/^[a-z][a-z0-9_-]*$/.test(config.strategy) ||
      !Number.isSafeInteger(config.capacity) || config.capacity < 1 ||
      !Number.isSafeInteger(config.workerRetryMax) || config.workerRetryMax < 1 ||
      !Number.isSafeInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) throw Error("Invalid dispatcher configuration");
  if (config.enabled && !config.concurrentRequests) throw Error("Dispatcher requires explicit concurrentRequests support");
  if (config.swarm !== undefined) {
    const swarm = swarmConfig(config.swarm);
    // Swarm proposals come from the sequential planner; never silently ignored.
    if (swarm.enabled && config.strategy !== "sequential") throw Error("dispatcher.swarm requires strategy sequential");
    config.swarm = swarm;
  }
  if (config.rules !== undefined) {
    if (!Array.isArray(config.rules) || config.rules.length > 8) throw Error("Invalid dispatcher configuration");
    const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh"];
    const isFallback = (rule: DispatchModelRule): boolean =>
      rule.match === undefined || (typeof rule.match === "object" && rule.match !== null && !Array.isArray(rule.match) && Object.keys(rule.match).length === 0);
    for (let i = 0; i < config.rules.length; i++) {
      const rule = config.rules[i];
      if (!rule || typeof rule !== "object" || Array.isArray(rule) ||
          Object.keys(rule).some(key => !["match", "model", "thinking"].includes(key)) ||
          typeof rule.model !== "string" || !rule.model || rule.model.length > 200 || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(rule.model) ||
          (rule.thinking !== undefined && (typeof rule.thinking !== "string" || !THINKING.includes(rule.thinking)))) throw Error("Invalid dispatcher configuration");
      if (isFallback(rule)) {
        // At most one fallback rule, and only as the last rule.
        if (i !== config.rules.length - 1) throw Error("Invalid dispatcher configuration");
        continue;
      }
      const match = rule.match;
      if (!match || typeof match !== "object" || Array.isArray(match) ||
          Object.keys(match).some(key => !["minChars", "maxChars", "keywords", "regex"].includes(key)) ||
          (match.minChars !== undefined && (!Number.isSafeInteger(match.minChars) || match.minChars < 0)) ||
          (match.maxChars !== undefined && (!Number.isSafeInteger(match.maxChars) || match.maxChars < 0)) ||
          (match.minChars !== undefined && match.maxChars !== undefined && match.maxChars < match.minChars) ||
          (match.keywords !== undefined && (!Array.isArray(match.keywords) || match.keywords.length > 20 || match.keywords.some((word) => typeof word !== "string" || !word.trim() || word.length > 100))) ||
          (match.regex !== undefined && (typeof match.regex !== "string" || !match.regex || match.regex.length > 200))) throw Error("Invalid dispatcher configuration");
      if (match.regex !== undefined) {
        try { new RegExp(match.regex); } catch { throw Error("Invalid dispatcher configuration"); }
      }
      // Match present but no effective condition counts as a fallback rule.
      if (!match.minChars && match.maxChars === undefined && !(match.keywords?.length) && match.regex === undefined && i !== config.rules.length - 1) {
        throw Error("Invalid dispatcher configuration");
      }
    }
  }
  return config;
}

/** Deterministic per-task rule selection: first matching rule wins, empty match is the fallback. */
export function pickModelRule(text: string, rules?: DispatchModelRule[]): DispatchModelRule | undefined {
  if (!rules?.length) return undefined;
  const lower = text.toLowerCase();
  for (const rule of rules) {
    const match = rule.match;
    if (match === undefined) return rule;
    if (match.minChars !== undefined && text.length < match.minChars) continue;
    if (match.maxChars !== undefined && text.length > match.maxChars) continue;
    if (match.keywords?.length && !match.keywords.some((word) => lower.includes(word.toLowerCase()))) continue;
    if (match.regex !== undefined) {
      try { if (!new RegExp(match.regex).test(text)) continue; } catch { continue; }
    }
    return rule;
  }
  return undefined;
}
