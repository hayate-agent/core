import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";

/** No session selector: runtime context owns the conversation boundary. */
export function loopPlugin(harness: Harness): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_loop", description: "Manage a loop only in the current conversation: status, set (also replaces an existing loop), pause, resume, stop. Set requires prompt and everyMs >=60000; optional times limits executions. First execution is eligible on the next idle tick. Stop removes queued loop prompts, not the active turn. Mutations await durable state saving; errors do not confirm persistence. Use only for explicitly authorized recurring work.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["status", "set", "pause", "resume", "stop"] },
        prompt: { type: "string", minLength: 1, maxLength: 4000 },
        everyMs: { type: "integer", minimum: 60000, maximum: Number.MAX_SAFE_INTEGER },
        times: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      }, required: ["action"], additionalProperties: false },
      async execute(input, ctx) {
        if (Object.keys(input).some((key) => !["action", "prompt", "everyMs", "times"].includes(key))) throw Error("Unknown loop parameter");
        const loop = await harness.controlLoop(ctx.sessionKey, input as { action: string; prompt?: string; everyMs?: number; times?: number });
        return JSON.stringify({ loop });
      },
    });
  } };
}
