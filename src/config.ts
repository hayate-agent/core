import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse } from "yaml";
import { validateGatewayConfig, type GatewayConfig } from "./gateway-settings.js";
import { reviewConfig } from "./review-config.js";

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
  /** Agent identity key (e.g. "example-agent"). */
  agent: string;
  /** Harness home: sessions, state, persona files. */
  home: string;
  /** Working directory for tools. */
  cwd: string;
  timezone: string;
  model?: string;
  thinking?: string;
  review?: Partial<Omit<ReviewConfig, "mandatory" | "scope">> & { mandatory?: Partial<ReviewConfig["mandatory"]>; scope?: Partial<ReviewConfig["scope"]> };
  /** Literal tool names exposed to the model; omitted = runtime defaults, [] = no tools. */
  tools?: string[];
  /** Trusted local ESM plugin paths, relative to Harness home or absolute. */
  plugins?: string[];
  sessions?: { provider: string; options?: unknown };
  compaction?: { strategy: string };
  gateways?: GatewayConfig;
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
  if (overrides.mcp !== undefined && (overrides.mcp === null || typeof overrides.mcp !== "object" || typeof overrides.mcp.enabled !== "boolean")) {
    throw new Error("mcp.enabled must be a boolean");
  }
  if (overrides.sessions !== undefined && (!overrides.sessions || typeof overrides.sessions.provider !== "string" || !/^[a-z][a-z0-9_-]*$/.test(overrides.sessions.provider))) throw new Error("Invalid sessions.provider");
  if (overrides.compaction !== undefined && (!overrides.compaction || typeof overrides.compaction.strategy !== "string" || !/^[a-z][a-z0-9_-]*$/.test(overrides.compaction.strategy))) throw new Error("Invalid compaction.strategy");
  reviewConfig(overrides.review); // validate before startup
  validateGatewayConfig(overrides.gateways);
  const home = overrides.home ?? process.env.VANILLACORE_HARNESS_HOME ?? path.join(os.homedir(), ".vanillacore-harness");
  return {
    agent: overrides.agent ?? process.env.VANILLACORE_HARNESS_AGENT ?? "agent",
    home,
    cwd: overrides.cwd ?? process.cwd(),
    timezone: overrides.timezone ?? process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    model: overrides.model,
    thinking: overrides.thinking,
    review: reviewConfig(overrides.review),
    plugins: overrides.plugins ?? [],
    sessions: overrides.sessions ?? { provider: "native" },
    compaction: overrides.compaction ?? { strategy: "native" },
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
    loop: { tickMs: 15_000, busyMode: "queue", drainSeconds: 60, ...overrides.loop },
    memoryGuard: { percent: 90, ...overrides.memoryGuard },
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
