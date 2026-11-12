import type { Harness } from "./harness.js";
import { ToolGuardError } from "./tool-guard-error.js";
import { repetitions } from "./repetition-budget.js";

const orchestration = new Set(["plugin_worker_tasks", "plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"]);

/** Validate stored provenance, not natural-language scope. Main reasons within
 * the original mandate; permissions, approvals, review and worker gates remain. */
export function guardResultOrchestration(harness: Harness, key: string, tool: string, args?: unknown): void {
  const input = harness.sessions.get(key)?.current;
  if (input?.source !== "host") return;
  const mandate = harness.resultMandate(input);
  const plan = args as { action?: unknown; state?: unknown } | null;
  // A validated host result may inspect its parent's existing executions even
  // without productive continuation authority (for example an API-only turn).
  // The caller's host-event guard and dispatcher's parent scope still apply.
  if (["plugin_dispatch", "plugin_worker_tasks"].includes(tool) && plan?.action === "status") return;
  if (!mandate && orchestration.has(tool)) throw new ToolGuardError("parent_mandate_missing", "Result orchestration requires a live stored parent mandate");
  if (!mandate) return;
  // Reporting a blocker/completion or inspecting existing work is still valid at
  // the limit. Do not misreport exhausted productive budget as revoked authority.
  const session = harness.sessions.get(key)!;
  const task = session.tasks?.find(task => task.id === mandate.taskId) ?? session.task;
  if ((!task || repetitions(task) >= 20) &&
      !(tool === "plugin_task_continuation" && plan?.state !== "continue") &&
      !(["plugin_dispatch", "plugin_worker_tasks"].includes(tool) && plan?.action === "status"))
    throw new ToolGuardError("continuation_budget_exhausted", `Task ${mandate.taskId}: productive continuation budget exhausted; status rechecks only`);
}
