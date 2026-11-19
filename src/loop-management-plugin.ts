import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";

/** Main-owned recurring loops: exact session identities, never a bulk mutation. */
export function loopManagementPlugin(harness: Harness, inspectAll: (key: string) => boolean = () => false): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_loop", description: "Manage saved recurring loops. list inventories loops across conversations; status, set, pause, resume and stop default to this conversation or accept an exact sessionKey from list. Stop removes that loop and its queued loop occurrences, not the active turn or unrelated tasks. Mutations are persisted before success. Use the operator's requested scope; never claim an active turn was aborted by stop.",
      parameters: { type: "object", properties: {
        action: { type: "string", enum: ["list", "status", "set", "pause", "resume", "stop"] },
        sessionKey: { type: "string", minLength: 1 }, prompt: { type: "string", minLength: 1, maxLength: 4000 },
        everyMs: { type: "integer", minimum: 60000 }, times: { type: "integer", minimum: 1 },
      }, required: ["action"], additionalProperties: false },
      async execute(input, ctx) {
        if (/^(dispatch|subagent):/.test(ctx.sessionKey)) throw Error("Loop management is main-owned");
        if (Object.keys(input).some(key => !["action", "sessionKey", "prompt", "everyMs", "times"].includes(key))) throw Error("Unknown loop parameter");
        if (input.action === "list") {
          if (input.sessionKey !== undefined) throw Error("List does not accept a session selector");
          return JSON.stringify({ loops: [...harness.sessions.values()].filter(s => s.loop && (s.key === ctx.sessionKey || inspectAll(ctx.sessionKey))).map(s => ({ sessionKey: s.key, loop: structuredClone(s.loop), queued: s.queue.filter(i => i.source === "loop").length, active: s.current?.source === "loop" })) });
        }
        const target = input.sessionKey === undefined ? ctx.sessionKey : input.sessionKey;
        if (typeof target !== "string" || !target || (target !== ctx.sessionKey && !harness.sessions.has(target))) throw Error("Exact existing session required");
        if (target !== ctx.sessionKey && !inspectAll(ctx.sessionKey)) throw Error("Cross-conversation loop access requires operator scope");
        const loop = await harness.controlLoop(target, input as { action: string; prompt?: string; everyMs?: number; times?: number });
        return JSON.stringify({ sessionKey: target, loop });
      },
    });
  } };
}
