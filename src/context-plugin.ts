import type { PluginModule } from "./plugins.js";
import type { ContextMaintenance } from "./context-maintenance.js";
import type { SettingsService } from "./settings.js";
export function contextPlugin(maintenance: ContextMaintenance, settings: SettingsService): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_context_maintenance", description: "Request compaction or a fresh-session handover at the next safe turn boundary. Preserve operator intent, verified state, open work and next steps; never include secrets. Does not execute immediately.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["compact", "handover"] }, preserve: { type: "string" }, resume: { type: "string" } }, required: ["action", "preserve", "resume"], additionalProperties: false },
      async execute(input, ctx) {
        await maintenance.request(ctx.sessionKey, input as { action: "compact" | "handover"; preserve: string; resume: string });
        return "Context maintenance requested for the safe boundary after this working turn. Finish a coherent checkpoint; no need to repeat the request.";
      },
    });
    api.registerCommand({ name: "context-policy", help: "Context maintenance: status | on | off | handover-on | handover-off", async run(args) {
      const value = args.trim();
      if (value && value !== "status") {
        if (value === "on" || value === "off") await settings.setContext({ enabled: value === "on" });
        else if (value === "handover-on" || value === "handover-off") await settings.setContext({ autoHandover: value === "handover-on" });
        else throw new Error("Use status, on, off, handover-on or handover-off");
      }
      return JSON.stringify(settings.effective().contextMaintenance);
    } });
  } };
}
