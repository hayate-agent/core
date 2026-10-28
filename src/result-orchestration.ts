import type { Harness } from "./harness.js";
import { ToolGuardError } from "./tool-guard-error.js";

const orchestration = new Set(["plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"]);

/** Validate stored provenance, not natural-language scope. Main reasons within
 * the original mandate; permissions, approvals, review and worker gates remain. */
export function guardResultOrchestration(harness: Harness, key: string, tool: string, args?: unknown): void {
  const input = harness.sessions.get(key)?.current;
  if (input?.source !== "host") return;
  const mandate = harness.resultMandate(input);
  if (!mandate && orchestration.has(tool)) throw new ToolGuardError("authority_revoked", "Result orchestration requires a live stored parent mandate");
  if (!mandate) return;
  // Reporting a blocker/completion or inspecting existing work is still valid at
  // the limit. Do not misreport exhausted productive budget as revoked authority.
  const plan = args as { action?: unknown; state?: unknown } | null;
  if (mandate.depth >= 20 &&
      !(tool === "plugin_task_continuation" && plan?.state !== "continue") &&
      !(tool === "plugin_dispatch" && plan?.action === "status"))
    throw new ToolGuardError("continuation_budget_exhausted", `Task ${mandate.taskId}: productive continuation budget exhausted; status rechecks only`);
}
