/** Orchestration tools a child session must not call. The parent owns
 * continuation, delegation and loops; a child returns its outcome as its final
 * reply, which the host records durably. One list feeds both the runtime guard
 * and the model-visible tool selection, so advertised tools match enforcement.
 */
const WORKER = ["plugin_tasks", "plugin_dispatch_recovery", "plugin_worker_tasks", "plugin_dispatch", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"] as const;
const SUBAGENT = ["plugin_tasks", "plugin_dispatch_recovery", "plugin_subagent", "plugin_loop", "plugin_task_continuation", "plugin_improvement_evaluate"] as const;

export function childDeniedTools(sessionKey: string): readonly string[] {
  if (sessionKey.startsWith("dispatch:")) return WORKER;
  if (sessionKey.startsWith("subagent:")) return SUBAGENT;
  return [];
}

export const CHILD_OUTCOME_CONTRACT = "Worker contract: execute a bounded coherent work package; several related steps/toolcalls are normal. Return a concise outcome with evidence references, uncertainties and remaining work, not tool logs, file dumps or loaded context. Store details in task/session artifacts. The parent owns continuation, scheduling and delegation; do not simulate those tools. Keep reads targeted and reconcile uncertain effects; never replay completed effects or claim unverified completion. Finish a useful checkpoint and report incomplete work honestly. Compaction/handover never renews authority.";
