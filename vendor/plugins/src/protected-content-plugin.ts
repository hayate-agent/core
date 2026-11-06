import type { PluginModule } from "./plugins.js";
import type { ProtectedContent } from "./protected-content.js";
export function protectedContentPlugin(service: ProtectedContent): PluginModule {
    return { apiVersion: 1, activate: (api) => {
      api.registerCommand({ name: "protected-content", admin: true, help: "Inspect infrastructure-pinned content integrity", run: async (args) => {
        if (args.trim() && args.trim() !== "status") throw Error("Use /protected-content status");
        return JSON.stringify({ enforcement: "integrity-only; use read-only infrastructure mounts for write protection", files: await service.inspect() });
      } });
    } };
}
