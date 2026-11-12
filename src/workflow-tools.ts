/** Keep bundled workflow tools reachable under explicit nonempty runtime selection.
 * An explicitly empty list still disables all model-visible tools.
 */
export function workflowTools(tools: string[] | undefined, memory: boolean, review: boolean): string[] | undefined {
  if (!tools?.length) return tools;
  return [...new Set([...tools, "plugin_message", "plugin_task_continuation", "plugin_subagent", "plugin_loop", "plugin_improvement_evaluate", "plugin_context_maintenance", "plugin_session_history", ...(memory ? ["plugin_memory"] : []), ...(review ? ["plugin_review"] : [])])];
}
