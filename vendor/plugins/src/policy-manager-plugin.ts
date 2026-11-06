// SPDX-License-Identifier: Apache-2.0
import type { PluginModule } from "./plugins.js";
import type { PolicyManager } from "./policy-manager.js";
import type { SettingsService } from "./settings.js";

/** Privileged by the host command dispatcher; no agent-visible policy mutation tool. */
export function policyManagerPlugin(service: PolicyManager, settings: SettingsService): PluginModule {
  return { apiVersion: 1, activate: api => {
    api.registerCommand({ name: "policy-plugin", help: "Runtime policies: status | reload <id> | use <id> <module-path> | disable <id> | baseline <id>", run: async args => {
      const [action = "status", id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "status" && !id) return service.status();
      if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw Error("Invalid policy ID");
      if (action === "use" && rest.length === 1) {
        const spec = { module: rest[0] }; service.validate(id, spec);
        await settings.setPolicyPlugin(id, spec);
      } else if (action === "disable" && !rest.length) {
        const spec = { disabled: true }; service.validate(id, spec);
        await settings.setPolicyPlugin(id, spec);
      } else if (action === "baseline" && !rest.length) {
        service.validate(id, {}); await settings.setPolicyPlugin(id);
      } else if (action === "reload" && !rest.length) service.validate(id);
      else throw Error("Use status|reload <id>|use <id> <path>|disable <id>|baseline <id>");
      await service.request(id);
      return `Policy ${id}: activation pending idle boundary. /policy-plugin status reports active/pending/errors.`;
    } });
  } };
}
