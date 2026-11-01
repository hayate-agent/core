import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Canonical defaults; legacy lookup only preserves existing local agent state. */
export function agentHome(explicit?: string, env = process.env, userHome = os.homedir()): string {
  if (explicit !== undefined) return explicit;
  if (env.HAYATE_AGENT_HOME !== undefined) return env.HAYATE_AGENT_HOME;
  if (env.VANILLACORE_HARNESS_HOME !== undefined) return env.VANILLACORE_HARNESS_HOME;
  const canonical = path.join(userHome, ".hayate-agent");
  const legacy = path.join(userHome, ".vanillacore-harness");
  if (existsSync(canonical) && existsSync(legacy)) {
    throw Error("Both Hayate Agent and legacy homes exist; select the authoritative home with HAYATE_AGENT_HOME or --home. No state was moved.");
  }
  return existsSync(legacy) ? legacy : canonical;
}

export function configurationFile(home: string): string {
  const canonical = path.join(home, "hayate-agent.yaml");
  const legacy = path.join(home, "harness.yaml");
  return existsSync(canonical) ? canonical : existsSync(legacy) ? legacy : canonical;
}

export function reasoningEffortNoneModels(env = process.env): string[] {
  return (env.HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS ?? env.HARNESS_REASONING_EFFORT_NONE_MODELS ?? "")
    .split(",").map(value => value.trim()).filter(Boolean);
}
