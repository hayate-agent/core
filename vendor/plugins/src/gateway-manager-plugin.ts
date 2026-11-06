// SPDX-License-Identifier: Apache-2.0
import type { PluginModule } from "./plugins.js";
import type { GatewayManager } from "./gateway-manager.js";
import type { SettingsService } from "./settings.js";
export function gatewayManagerPlugin(service: GatewayManager, settings: SettingsService): PluginModule {
    return { apiVersion: 1, activate: (api) => {
      api.registerCommand({ name: "gateway-plugin", help: "Runtime gateway modules: status | reload <id> | use <id> <module-path> | disable <id> | baseline <id>", run: async (args) => {
        const [action = "status", name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status") return service.status();
        if (!name || !/^[a-z][a-z0-9_-]*$/.test(name) || ["console", "api", "subagents", "dispatch"].includes(name)) throw Error("Invalid gateway ID");
        if (action === "use" && rest.length === 1) await settings.setGatewayPlugin(name, { module: rest[0] });
        else if (action === "disable" && !rest.length) await settings.setGatewayPlugin(name, { disabled: true });
        else if (action === "baseline" && !rest.length) await settings.setGatewayPlugin(name, undefined);
        else if (action !== "reload" || rest.length) throw Error("Use status|reload <id>|use <id> <path>|disable <id>|baseline <id>");
        await service.request(name);
        return `Gateway ${name}: configuration saved, activation pending idle boundary. /gateway-plugin status reports active/pending/errors.`;
      } });
    } };
}
