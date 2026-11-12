import os from "node:os";
import path from "node:path";

/** Canonical defaults; explicit homes may point at any existing state directory. */
export function agentHome(explicit?: string, env = process.env, userHome = os.homedir()): string {
  if (explicit !== undefined) return explicit;
  if (env.HAYATE_AGENT_HOME !== undefined) return env.HAYATE_AGENT_HOME;
  return path.join(userHome, ".hayate-agent");
}

export function configurationFile(home: string): string {
  return path.join(home, "hayate-agent.yaml");
}

export function reasoningEffortNoneModels(env = process.env): string[] {
  return (env.HAYATE_AGENT_REASONING_EFFORT_NONE_MODELS ?? "")
    .split(",").map(value => value.trim()).filter(Boolean);
}
