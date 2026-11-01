import type { PluginModule } from "./plugins.js";
import type { SettingsService } from "./settings.js";
import type { Harness } from "./harness.js";
export function gatewayPlugin(settings: SettingsService, harness: Harness): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "gateway", help: "Live gateway feedback: status | progress off|reduced|full | reactions on|off (persistent)", async run(args) {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (!parts.length || (parts.length === 1 && parts[0] === "status")) return JSON.stringify(settings.effective().gateways);
      if (parts.length !== 2) throw Error("Use status | progress off|reduced|full | reactions on|off");
      if (parts[0] === "progress" && ["off", "reduced", "full"].includes(parts[1])) await settings.setGateways({ progress: parts[1] as "off" | "reduced" | "full" });
      else if (parts[0] === "reactions" && ["on", "off"].includes(parts[1])) await settings.setGateways({ statusReactions: parts[1] === "on" });
      else throw Error("Use status | progress off|reduced|full | reactions on|off");
      harness.configureGateways(settings.effective().gateways ?? {});
      return `Gateway settings saved and applied (explicit channel/environment overrides still take precedence): ${JSON.stringify(settings.effective().gateways)}`;
    } });
  } };
}
