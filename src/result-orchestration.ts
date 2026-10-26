import type { Harness } from "./harness.js";
import { ToolGuardError } from "./tool-guard-error.js";

const orchestration = new Set(["plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"]);

/** Validate stored provenance, not natural-language scope. Main reasons within
 * the original mandate; permissions, approvals, review and worker gates remain. */
export function guardResultOrchestration(harness: Harness, key: string, tool: string): void {
  const input = harness.sessions.get(key)?.current;
  if (input?.source !== "host" || !orchestration.has(tool)) return;
  if (!harness.resultMandate(input)) throw new ToolGuardError("authority_revoked", "Result orchestration requires a live stored parent mandate");
}
