// SPDX-License-Identifier: Apache-2.0
import type { PluginModule } from "./plugins.js";
import type { ReloadableTools } from "./reloadable-tools.js";
export function reloadableToolsPlugin(service: ReloadableTools): PluginModule {
    return { apiVersion: 1, activate: async api => {
      api.onStop(() => service.stop());
      await service.reload();
      for (const tool of service.tools.values()) api.registerTool(tool);
      api.registerCommand({ name: "tool-plugin", help: "Trusted tool plugins: status | reload", admin: true,
        run: async args => {
          const action = args.trim() || "status";
          if (action === "reload") { await service.reload(); return "Tool plugins reloaded"; }
          if (action !== "status") throw Error("usage: /tool-plugin status|reload");
          return `${service.tools.size} tool(s); ${service.loadAttempts}/50 load attempts; ${service.liveGenerations} live generation(s)`;
        },
      });
    } };
}
