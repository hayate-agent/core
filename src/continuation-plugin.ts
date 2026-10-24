import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";
import type { Inbound } from "./types.js";

export function continuationPlugin(harness: Harness): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_task_continuation", description: "Record whether the explicitly authorized task has a safe next step after this turn, is waiting/blocked, or is complete. A continue plan queues at most one durable follow-up, limited to 20 consecutive follow-ups. Never invent authorization or bypass approvals.",
      parameters: { type: "object", properties: { state: { type: "string", enum: ["continue", "waiting", "blocked", "completed"] }, next: { type: "string", maxLength: 4000 } }, required: ["state"], additionalProperties: false },
      async execute(input, ctx) {
        harness.planContinuation(ctx.sessionKey, input as NonNullable<Inbound["continuation"]>);
        return "Continuation status recorded for the durable turn-end checkpoint; no extra model call has started.";
      },
    });
  } };
}
