import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";
import { isTaskPriority, type TaskPriority } from "./task-priority.js";

/** Parent coordination only. Worker output is never authority to reprioritize. */
export function taskPriorityPlugin(harness: Harness,
  authorize: (key: string, taskId: string, priority: TaskPriority, signal?: AbortSignal) => boolean | Promise<boolean>): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_task_priority",
      description: "Inspect durable priorities and task IDs in this conversation, or persist an explicit operator-requested task priority (high/normal/low). Use set only when the current authenticated operator requested that ordering, not to infer urgency from worker prose. Priorities guide Main and its queued Dispatcher work after restart; they never resume blocked/stopped work, reset budgets, preempt running workers or grant effect replay. Independent tasks can use available Dispatcher slots concurrently; sequential means steps within ONE task, not all tasks globally. Use list to see other retained authorized work rather than waiting for one child before coordinating unrelated tasks.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "set"] }, taskId: { type: "string" }, priority: { type: "string", enum: ["low", "normal", "high"] }, offset: { type: "integer", minimum: 0 } }, required: ["action"], additionalProperties: false },
      async execute(input, context) {
        if (context.sessionKey.startsWith("dispatch:") || context.sessionKey.startsWith("subagent:")) throw Error("Parent coordination only");
        const session = harness.sessions.get(context.sessionKey);
        if (!session) throw Error("Unknown conversation");
        if (input.action === "set") {
          if (typeof input.taskId !== "string" || !isTaskPriority(input.priority)) throw Error("Task ID and valid priority required");
          if (!await authorize(context.sessionKey, input.taskId, input.priority, context.signal)) throw Error("Authenticated operator priority request required");
          context.signal?.throwIfAborted();
          await harness.setTaskPriority(context.sessionKey, input.taskId, input.priority);
        } else if (input.action !== "list") throw Error("Invalid priority action");
        const offset = input.offset ?? 0;
        if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw Error("Invalid offset");
        const tasks = (session.tasks ?? (session.task ? [session.task] : [])).filter(task => input.taskId === undefined
          ? task.recoveryEnrollment !== "held-legacy" && !["completed", "stopped"].includes(task.state) : task.id === input.taskId);
        return JSON.stringify({ total: tasks.length, offset, tasks: tasks.slice(offset as number, (offset as number) + 25).map(task => ({ id: task.id,
          original: task.original.slice(0, 1000), state: task.state, priority: harness.taskPriority(context.sessionKey, task.id) ?? "normal", next: task.next?.slice(0, 1000),
          expiresAt: task.expiresAt, explicitBlocked: task.explicitBlocked, termination: task.termination, assessmentRetryAt: task.recoveryRetry?.nextAt })) });
      },
    });
  } };
}
