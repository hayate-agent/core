// SPDX-License-Identifier: Apache-2.0
import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";
import type { Inbound } from "./types.js";

export function continuationPlugin(harness: Harness): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_task_continuation", description: "Record whether the explicitly authorized task has a safe next step after this turn, is waiting/blocked, or is complete. A continue plan queues at most one durable follow-up, limited to 20 consecutive follow-ups. For an external dependency, waiting + next + wait registers a persistent bounded recheck (60s–24h interval, deadline within 7 days); plain waiting has no automatic wakeup. Rechecks inherit the original task and deadline, not new authority. Use optional taskId only for an exact eligible stored task from Continuation scope in the turn context; omission means the current task. A narrow subtask completion must name its own ID, not a broader mandate. Targeting retains the stored original authority and deadline, never permissions from a short question. Never invent authorization or bypass approvals. Optional replyKind classifies the ENTIRE turn reply: routine only if it contains no substantive result (including partial results) and no attention request (including approvals or blockers); substantive or absent keeps chat delivery. A routine designation only permits status routing for an otherwise unchanged bounded wait recheck; it does not suppress other replies.",
      parameters: { type: "object", properties: { taskId: { type: "string", minLength: 1, maxLength: 256, description: "Optional exact eligible stored task ID from turn context; defaults to the current task." }, state: { type: "string", enum: ["continue", "waiting", "blocked", "completed"] }, replyKind: { type: "string", enum: ["routine", "substantive"], description: "Classifies the ENTIRE turn reply. Use routine only when there is no substantive result (even partial) and no attention request, approval or blocker. Substantive or omitted preserves chat; routine only permits status routing for an unchanged bounded wait recheck." }, next: { type: "string", maxLength: 4000 }, wait: { type: "object", properties: { reason: { type: "string", minLength: 1, maxLength: 1000 }, retryAfterMs: { type: "integer", minimum: 60000, maximum: 86400000 }, deadline: { type: "integer" } }, required: ["reason", "retryAfterMs", "deadline"], additionalProperties: false } }, required: ["state"], additionalProperties: false },
      async execute(input, ctx) {
        // Older Core silently drops taskId; never let an explicit target hit its current-task path.
        if (input.taskId !== undefined && typeof (harness as { continuationTasks?: unknown }).continuationTasks !== "function")
          throw new Error("Explicit taskId continuation requires Core support (continuationTasks); checkpoint unchanged.");
        harness.planContinuation(ctx.sessionKey, input as NonNullable<Inbound["continuation"]>);
        const plan = input as NonNullable<Inbound["continuation"]>;
        return plan.wait ? "Bounded wait recorded for the durable turn-end checkpoint; timer will recheck, not assume the condition fulfilled."
          : plan.state === "waiting" ? "Waiting recorded WITHOUT automatic wakeup. Supply next and wait to register a bounded recheck."
          : "Continuation status recorded for the durable turn-end checkpoint; no extra model call has started.";
      },
    });
  } };
}
