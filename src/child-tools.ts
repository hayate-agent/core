/** Orchestration tools a child session must not call. The parent owns
 * continuation, delegation and loops; a child returns its outcome as its final
 * reply, which the host records durably. One list feeds both the runtime guard
 * and the model-visible tool selection, so advertised tools match enforcement.
 */
const WORKER = ["plugin_worker_tasks", "plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"] as const;
const SUBAGENT = ["plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"] as const;

export function childDeniedTools(sessionKey: string): readonly string[] {
  if (sessionKey.startsWith("dispatch:")) return WORKER;
  if (sessionKey.startsWith("subagent:")) return SUBAGENT;
  return [];
}

export const CHILD_OUTCOME_CONTRACT = "Worker contract: your final reply is your durable task outcome; the host records it and delivers it to the parent. Return the result with evidence, or a concrete blocker, as that reply. The parent owns continuation, scheduling and delegation; task continuation, loop and delegation tools are not available here, so do not request or simulate them. Work on a bounded coherent slice, not an open-ended project. If the mandate is too broad, finish a useful verified checkpoint and explicitly report remaining work as incomplete; never claim the whole task complete. Keep tool output and file reads targeted rather than loading entire reports or logs. Preserve decisions, verified effects, uncertain effects, constraints and concrete next steps in a durable checkpoint. Use available context-maintenance tools at safe boundaries when needed, then finish the turn so the host can perform handover; do not keep accumulating history while waiting or polling. A handover or compaction never renews permissions or authorizes replay of effects.";
