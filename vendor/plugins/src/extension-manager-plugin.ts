import type { PluginModule } from "./plugins.js";
import type { ExtensionManager } from "./extension-manager.js";
import type { SettingsService } from "./settings.js";

export function extensionManagerPlugin(service: ExtensionManager, settings: SettingsService): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "extension-plugin", admin: true,
      help: "Runtime extensions: status | use <id> <path> | reload <id> | disable <id> | remove <id>",
      async run(args) {
        const [action = "status", id, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status" && !id) return service.status();
        if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) throw Error("Invalid extension ID");
        if (action === "use" && rest.length === 1) await settings.setExtensionPlugin(id, { module: rest[0] });
        else if (action === "disable" && !rest.length) await settings.setExtensionPlugin(id, { disabled: true });
        else if (action === "remove" && !rest.length) await settings.setExtensionPlugin(id);
        else if (action !== "reload" || rest.length) throw Error("Use status|use <id> <path>|reload <id>|disable <id>|remove <id>");
        service.request(id);
        return `Extension ${id}: desired state saved, activation pending idle boundary. /extension-plugin status reports lifecycle errors.`;
      } });
  } };
}
