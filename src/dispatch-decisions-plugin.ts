import type { Dispatcher } from "./dispatcher.js";
import { validExecutionFollowUp, executionDecisionRevision } from "./execution.js";
import type { PluginModule } from "./plugins.js";

/** Supported parent-owned recovery from bounded active steering capacity. */
export function dispatchDecisionsPlugin(get: () => Dispatcher | undefined): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_dispatch_decisions",
      description: "Inspect an existing execution's active steering decisions or exact archived receipt, or CONSOLIDATE explicitly superseded APPLIED parent working instructions when plugin_dispatch decide reports decision data/count limit. Preserve all original operator scope, prohibitions, required gates and unknown-effect reconciliation in the replacement context. This is an explicit parent amendment, never automatic lossy compaction, permission, completion, effect retry or budget reset. Use status first, then consolidate with exact replaces requestIds and complete current scoped context. Exact old records remain available through read. Pending decisions cannot be discarded. Same existing execution/sole writer; do not spawn another worker or ask the operator to edit ledgers. Only this parent conversation may amend its steering. If a later amendment requires unfinished work not represented by a remaining plan step (e.g. compatibility repair after publication), supply followUp with the exact scoped task, lowest sufficient role, reason and required evidence. The same execution preserves its held work and independently admits that follow-up; no new writer or completion waiver.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["status", "read", "consolidate"] }, id: { type: "string" },
        requestId: { type: "string" }, decision: { type: "string", maxLength: 4000 },
        replaces: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
        followUp: { type: "object", properties: { task: { type: "string", maxLength: 4000 }, role: { type: "string", enum: ["simple", "medium", "high"] },
          reason: { type: "string", maxLength: 500 }, evidence: { type: "string", maxLength: 1000 } }, required: ["task", "role", "reason", "evidence"], additionalProperties: false },
      }, required: ["action", "id"], additionalProperties: false },
      async execute(input, context) {
        if (/^(dispatch|subagent):/.test(context.sessionKey)) throw Error("Parent decision maintenance only; worker cannot alter steering");
        const dispatcher = get(); if (!dispatcher) throw Error("Dispatcher mode is not active");
        const task = dispatcher.store.list(context.sessionKey).find(task => task.id === input.id);
        if (!task) throw Error("Execution not in this conversation");
        if (input.action === "status") {
          let plan: { plan?: unknown[]; outcomes?: unknown[]; planHistory?: { head: string; completed: number }; lastFollowUpRevision?: number; appliedFollowUps?: string[] } | undefined;
          try { if (task.strategy === "sequential" && task.checkpoint) plan = JSON.parse(task.checkpoint); } catch { /* status is not a validation/authority grant */ }
          const planned = Array.isArray(plan?.plan) ? plan!.plan!.length : undefined;
          const completed = Array.isArray(plan?.outcomes) ? plan!.outcomes!.length : undefined;
          const followUps = task.decisions?.filter(d => d.followUp).map(d => ({ requestId: d.requestId, revision: d.revision,
            admission: (d.revision !== undefined && d.revision <= (plan?.lastFollowUpRevision ?? 0)) || plan?.appliedFollowUps?.includes(d.requestId)
              ? "retained-in-plan-or-completed-history" : "awaiting-plan-admission",
            queuedReason: !plan?.appliedFollowUps?.includes(d.requestId) && !(d.revision !== undefined && d.revision <= (plan?.lastFollowUpRevision ?? 0))
              ? planned !== undefined && planned >= 6 ? completed ? "completed-slots-await-archival" : "active-window-full" : "awaiting-strategy-boundary" : undefined }));
          return JSON.stringify({ id: task.id, status: task.status, revision: executionDecisionRevision(task.decisions), active: task.decisions, followUps,
            activeWindow: planned !== undefined ? { planned, completed, independentlyCompletedHistory: plan?.planHistory?.completed ?? 0, historyHead: plan?.planHistory?.head } : undefined,
            archive: "Exact archived originals remain accessible by requestId using read; replacements never change original mandate or effect ownership." });
        }
        if (typeof input.requestId !== "string") throw Error("Exact requestId required");
        if (input.action === "read") return JSON.stringify(await dispatcher.store.readDecision(context.sessionKey, task.id, input.requestId) ?? { error: "Decision receipt not found" });
        if (input.action !== "consolidate" || typeof input.decision !== "string" || !Array.isArray(input.replaces) || input.replaces.some(id => typeof id !== "string")) throw Error("Consolidate requires replacement scoped context and exact applied replaces IDs");
        if (input.followUp !== undefined && !validExecutionFollowUp(input.followUp)) throw Error("Invalid scoped follow-up");
        return JSON.stringify(await dispatcher.consolidateDecisions(context.sessionKey, task.id, input.requestId, input.decision, input.replaces as string[], input.followUp));
      },
    });
  } };
}
