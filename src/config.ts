import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { validateGatewayConfig, type GatewayConfig } from "./gateway-settings.js";
import { pruningPolicy } from "./tool-result-pruning.js";
import { contextPolicy } from "./context-maintenance.js";
import { memoryConfig, type MemoryConfig } from "./memory.js";
import { reviewConfig } from "./review-config.js";
import { validateWasmTools } from "./wasm-tools.js";
import { dispatcherConfig } from "./dispatcher-config.js";

export interface ReviewConfig {
  enabled: boolean;
  shellGuard: boolean;
  scope: { mode: "risk" | "all"; nonBlockingPaths: string[]; requiredPaths: string[] };
  model?: string;
  thinking: string;
  maxTurns: number;
  mandatory: { local: boolean; publish: boolean; merge: boolean };
  /** Branch/PR merge-base; default uses upstream merge-base or HEAD before local work. */
  baseRef?: string;
}

export interface HarnessConfig {
  activity?: import("./activity.js").ActivityPolicy;
  /** Agent identity key (e.g. "example-agent"). */
  agent: string;
  /** Harness home: sessions, state, persona files. */
  home: string;
  /** Working directory for tools. */
  cwd: string;
  timezone: string;
  model?: string;
  thinking?: string;
  /** Trusted local startup engine module; selects policy and tools together. */
  reviewEngine?: string;
  review?: Partial<Omit<ReviewConfig, "mandatory" | "scope">> & { mandatory?: Partial<ReviewConfig["mandatory"]>; scope?: Partial<ReviewConfig["scope"]> };
  /** Literal tool names exposed to the model; omitted = runtime defaults, [] = no tools. */
  tools?: string[];
  /** Trusted local ESM plugin paths, relative to Harness home or absolute. */
  plugins?: string[];
  /** Trusted tool-only ESM modules with explicit generation replacement. */
  reloadableToolPlugins?: string[];
  /** Opt-in entry-file checks before working turns. */
  autoReloadToolPlugins?: boolean;
  /** Restricted no-import WebAssembly tool modules; no WASI or host capabilities. */
  wasmTools?: import("./wasm-tools.js").WasmToolConfig[];
  protectedContent?: import("./protected-content.js").ProtectedContentConfig;
  skillUpdateSource?: import("./skill-updates.js").SkillUpdateSource;
  /** Infrastructure-owned semantic continuation grants, keyed by exact conversation. */
  completionCheck?: { authorizations: Record<string, import("./completion-check.js").CompletionAuthorization> };
  dispatcher?: Partial<import("./dispatcher-config.js").DispatcherConfig>;
  sessions?: { provider: string; options?: unknown };
  compaction?: { strategy: string };
  contextMaintenance?: Partial<import("./context-maintenance.js").ContextPolicy>;
  toolResultPruning?: Partial<import("./tool-result-pruning.js").PruningPolicy>;
  gateways?: GatewayConfig;
  memory: MemoryConfig;
  /** Enable configured MCP servers; credentials and server definitions stay outside product code. */
  mcp?: { enabled: boolean };
  persona: {
    /** Identity file (Hermes-compatible). */
    soul: string;
    /** Personality / tone file. */
    voice: string;
    /** Named personalities selectable via /personality, file per name. */
    personalitiesDir: string;
  };
  skills: {
    /** Extra skill dirs in addition to PI's global/project discovery. */
    paths: string[];
  };
  cron: {
    /** Hermes-compatible jobs.yaml; optional. */
    jobsFile?: string;
  };
  loop: {
    /** Idle tick of the main loop in ms (heartbeats, goals, loops are checked on each tick). */
    tickMs: number;
    busyMode: "queue" | "steer" | "interrupt";
    /** On SIGTERM / restart: wait this long for in-flight turns, then abort (Hermes restart_drain_timeout). */
    drainSeconds: number;
  };
  /** Container memory guard: kill the largest child above this % of the cgroup limit; 0 = off. */
  memoryGuard: { percent: number };
  /** Senders allowed to run privileged commands (/approve, /pause, /restart, /yolo ...). Empty = everyone. */
  admins: string[];
  /** Who may /approve, /deny (and react on Matrix). Empty: MATRIX_APPROVAL_APPROVERS, else admins. */
  approvers: string[];
  /** Home address for cron output and notices (/sethome). */
  home_address?: { channel: string; target: string };
}

export function defaultConfig(overrides: Partial<HarnessConfig> = {}): HarnessConfig {
  if (overrides.tools !== undefined && (!Array.isArray(overrides.tools) ||
      overrides.tools.some((name) => typeof name !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]*$/.test(name)))) {
    throw new Error("tools must be an array of literal tool names (or [] for no tools)");
  }
  if (overrides.plugins !== undefined && (!Array.isArray(overrides.plugins) || overrides.plugins.some((p) => typeof p !== "string" || !p.trim()))) {
    throw new Error("plugins must be an array of local module paths");
  }
  if (overrides.reloadableToolPlugins !== undefined && (!Array.isArray(overrides.reloadableToolPlugins) || overrides.reloadableToolPlugins.some(p => typeof p !== "string" || !p.trim()))) {
    throw Error("reloadableToolPlugins must be an array of local module paths");
  }
  if (overrides.autoReloadToolPlugins !== undefined && typeof overrides.autoReloadToolPlugins !== "boolean") throw Error("autoReloadToolPlugins must be a boolean");
  dispatcherConfig(overrides.dispatcher);
  validateWasmTools(overrides.wasmTools ?? []);
  if (overrides.mcp !== undefined && (overrides.mcp === null || typeof overrides.mcp !== "object" || typeof overrides.mcp.enabled !== "boolean")) {
    throw new Error("mcp.enabled must be a boolean");
  }
  if (overrides.sessions !== undefined && (!overrides.sessions || typeof overrides.sessions.provider !== "string" || !/^[a-z][a-z0-9_-]*$/.test(overrides.sessions.provider))) throw new Error("Invalid sessions.provider");
  if (overrides.compaction !== undefined && (!overrides.compaction || typeof overrides.compaction.strategy !== "string" || !/^[a-z][a-z0-9_-]*$/.test(overrides.compaction.strategy))) throw new Error("Invalid compaction.strategy");
  const loop = { tickMs: 15_000, busyMode: "queue" as const, drainSeconds: 60, ...overrides.loop };
  if (!Number.isInteger(loop.tickMs) || loop.tickMs < 1 || loop.tickMs > 2_147_483_647) {
    throw new Error("loop.tickMs must be an integer between 1 and 2147483647 milliseconds");
  }
  reviewConfig(overrides.review); // validate before startup
  if (overrides.reviewEngine !== undefined && (typeof overrides.reviewEngine !== "string" || !overrides.reviewEngine.trim() || overrides.reviewEngine.length > 2000)) throw Error("Invalid reviewEngine");
  contextPolicy(overrides.contextMaintenance);
  pruningPolicy(overrides.toolResultPruning);
  validateGatewayConfig(overrides.gateways);
  const activity = overrides.activity;
  if (activity !== undefined && (!activity || typeof activity !== "object" || Array.isArray(activity) ||
      (activity.enabled !== undefined && typeof activity.enabled !== "boolean") ||
      (activity.intervalMs !== undefined && (!Number.isFinite(activity.intervalMs) || activity.intervalMs < 1000 || activity.intervalMs > 300000)) ||
      (activity.maxAlive !== undefined && (!Number.isInteger(activity.maxAlive) || activity.maxAlive < 0 || activity.maxAlive > 120)))) {
    throw Error("Invalid activity policy");
  }
  const home = overrides.home ?? process.env.VANILLACORE_HARNESS_HOME ?? path.join(os.homedir(), ".vanillacore-harness");
  return {
    activity: overrides.activity,
    agent: overrides.agent ?? process.env.VANILLACORE_HARNESS_AGENT ?? "agent",
    home,
    cwd: overrides.cwd ?? process.cwd(),
    timezone: overrides.timezone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: overrides.model,
    thinking: overrides.thinking,
    review: reviewConfig(overrides.review),
    reviewEngine: overrides.reviewEngine,
    plugins: overrides.plugins ?? [],
    reloadableToolPlugins: overrides.reloadableToolPlugins ?? [],
    autoReloadToolPlugins: overrides.autoReloadToolPlugins ?? false,
    wasmTools: overrides.wasmTools ?? [],
    protectedContent: overrides.protectedContent,
    skillUpdateSource: overrides.skillUpdateSource,
    completionCheck: overrides.completionCheck,
    dispatcher: dispatcherConfig(overrides.dispatcher),
    sessions: overrides.sessions ?? { provider: "native" },
    compaction: overrides.compaction ?? { strategy: "native" },
    contextMaintenance: contextPolicy(overrides.contextMaintenance),
    toolResultPruning: pruningPolicy(overrides.toolResultPruning),
    gateways: overrides.gateways ?? { progress: "off", statusReactions: false },
    tools: overrides.tools === undefined ? undefined : [...new Set(overrides.tools)],
    mcp: overrides.mcp ?? { enabled: false },
    persona: {
      soul: path.join(home, "SOUL.md"),
      voice: path.join(home, "VOICE.md"),
      personalitiesDir: path.join(home, "personalities"),
      ...overrides.persona,
    },
    skills: { paths: [path.join(home, "skills")], ...overrides.skills },
    cron: { jobsFile: path.join(home, "cron", "jobs.yaml"), ...overrides.cron },
    loop,
    memoryGuard: { percent: 90, ...overrides.memoryGuard },
    memory: memoryConfig(overrides.memory),
    admins: overrides.admins ?? [],
    approvers: overrides.approvers ?? [],
    home_address: overrides.home_address,
  };
}

/** Load `<home>/harness.yaml` (if present) over the defaults. */
export async function loadConfig(home?: string): Promise<HarnessConfig> {
  const base = defaultConfig(home ? { home } : {});
  const file = path.join(base.home, "harness.yaml");
  let raw: Partial<HarnessConfig> = {};
  try {
    raw = (parse(await readFile(file, "utf8")) ?? {}) as Partial<HarnessConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return defaultConfig({ ...raw, home: base.home });
}
