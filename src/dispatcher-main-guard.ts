import { ToolGuardError } from "./tool-guard-error.js";

/** Host-enforced routing, not an instruction the working model may waive.
 * Shell is opaque: even a claimed read-only command can implement or publish.
 * Main retains native read/search and orchestration; shell work is delegated.
 */
export function guardDispatcherMain(key: string, tool: string, available: boolean, input?: unknown): void {
  if (!available || key.startsWith("dispatch:") || key.startsWith("subagent:")) return;
  const action = input && typeof input === "object" ? (input as { action?: unknown }).action : undefined;
  if (["bash", "write", "edit"].includes(tool) || tool === "plugin_subagent" && action === "start")
    throw new ToolGuardError("dispatcher_required", "Dispatcher is enabled and available. Delegate shell/implementation work through plugin_dispatch; a worker failure is not permission to implement in Main. Inspect the retained execution or let dispatcher recovery reconcile it. Main fallback is allowed only when the dispatcher is disabled or unavailable.");
}
