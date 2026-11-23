import { randomUUID } from "node:crypto";
import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";
import { renderTask, type TaskTodo } from "./task-lifecycle.js";

/** Thin Core command/tool surface; it does not own state or schedule a judge loop. */
export function taskLifecyclePlugin(harness: Harness, authorize: (key: string, proposal: object, signal?: AbortSignal) => Promise<boolean>,
  inspectAll: (key: string) => boolean = () => false): PluginModule {
  return { apiVersion: 1, activate(api) {
    const store = harness.opts.executionStore;
    if (!store) throw Error("Task lifecycle store required");
    api.registerCommand({ name: "orders", admin: true,
      help: "Agent-wide orders: /orders [show <id>|done <id>|reopen <id>]. Operator completion overrides technical validation.",
      async run(args, ctx) {
        if (!ctx.operatorAuthorized || ctx.source !== "channel") throw Error("Authentic operator command ingress required");
        const [action, id, ...extra] = args.trim().split(/\s+/);
        if (!args.trim()) return store.tasks().slice(-20).map(t => `${t.id} · ${t.operatorStatus} · ${t.original.slice(0, 140)}`).join("\n") || "Keine gespeicherten Aufträge.";
        const task = store.coreTask(id);
        if (!task || extra.length) throw Error("Use /orders show|done|reopen <exact-id>");
        if (action === "show") return renderTask(task);
        if (action !== "done" && action !== "reopen") throw Error("Use /orders show|done|reopen <exact-id>");
        return harness.operatorTaskDecision(id, action === "done" ? "close" : "reopen", `command:${ctx.inputId ?? randomUUID()}`, args, ctx.sessionKey);
      },
    });
    api.registerTool({ name: "plugin_tasks",
      description: "Core agent-wide operator orders, independent of sessions and Dispatcher. Use list/show to inspect; close/reopen/clarify ONLY for an actual current operator instruction (including clear natural-language completion), never a validator/worker suggestion. Clarify reuses the existing original order rather than creating another 'Weiter' mandate. For complex work propose-plan when useful: durable todos (not pushed to the operator's chat; they inspect them via /orders show) with original sourceId, choosing only steps relevant to the request. Done/omitted todos need outcome evidence. Changes are proposals, checked against operator scope and committed only at successful turn settlement. Simple questions need no plan. Never repeatedly validate closed tasks or reopen them on restart.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["list", "show", "close", "reopen", "clarify", "propose-plan"] },
        id: { type: "string" }, plan: { type: "array", maxItems: 48, items: { type: "object", properties: {
          id: { type: "string" }, title: { type: "string" }, kind: { type: "string", enum: ["memory-research", "skill-research", "source-research", "internet-research", "work", "verification", "skill-check", "skill-change", "delivery"] },
          status: { type: "string", enum: ["open", "running", "waiting", "done", "omitted"] }, sourceId: { type: "string" }, outcome: { type: "string" },
        }, required: ["id", "title", "kind", "status", "sourceId"], additionalProperties: false } },
      }, required: ["action"], additionalProperties: false },
      async execute(args, ctx) {
        if (/^(dispatch|subagent):/.test(ctx.sessionKey)) throw Error("Task lifecycle is parent-owned");
        const session = harness.sessions.get(ctx.sessionKey);
        const input = session?.current;
        const bound = new Set((session?.tasks ?? (session?.task ? [session.task] : [])).map(t => t.taskRef?.id));
        const visible = store.tasks().filter(t => inspectAll(ctx.sessionKey) || bound.has(t.id));
        if (args.action === "list") return JSON.stringify(visible.slice(-25).map(t => ({ id: t.id, generation: t.generation, revision: t.revision, operatorStatus: t.operatorStatus, original: t.original.slice(0, 1000) })));
        const task = visible.find(t => t.id === (args.id ?? input?.taskRef?.id));
        if (!task) throw Error("Exact stored task required");
        if (args.action === "show") return JSON.stringify(task);
        if (!input || !["channel", "api"].includes(input.source) && args.action !== "propose-plan") throw Error("Actual operator input required");
        const proposal = { action: args.action, task: { id: task.id, generation: task.generation, revision: task.revision,
          operatorStatus: task.operatorStatus, original: task.original, sources: task.sources, technical: task.technical, plan: task.plan },
          ...(args.action === "propose-plan" ? { plan: args.plan, observed: harness.taskPlanEvidence(ctx.sessionKey) } : {}) };
        if (!await authorize(ctx.sessionKey, proposal, ctx.signal)) throw Error("Proposal not supported by current operator authority/outcomes");
        ctx.signal?.throwIfAborted();
        if (harness.sessions.get(ctx.sessionKey)?.current !== input || store.coreTask(task.id)?.revision !== task.revision) throw Error("Task or input changed during authorization");
        if (args.action === "propose-plan") {
          if (input.taskRef?.id !== task.id || !Array.isArray(args.plan)) throw Error("Plan must belong to the current open order");
          harness.proposeTaskPlan(ctx.sessionKey, args.plan as TaskTodo[]);
          return "Planvorschlag vorgemerkt; wird erst mit dem Turn-Ergebnis dauerhaft übernommen und im Main-Thread angezeigt.";
        }
        if (!["close", "reopen", "clarify"].includes(String(args.action))) throw Error("Invalid task lifecycle action");
        return harness.operatorTaskDecision(task.id, args.action as "close" | "reopen" | "clarify", input.id ?? `operator:${randomUUID()}`, input.text, ctx.sessionKey, input);
      },
    });
  } };
}
