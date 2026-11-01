import type { PluginModule } from "./plugins.js";
import type { MemoryOrchestrationRegistry } from "./memory-orchestration.js";
import type { SettingsService } from "./settings.js";
import type { Harness } from "./harness.js";

/** Switch registered behavior only; never replace a provider or mutate stored data. */
export function memoryOrchestrationPlugin(registry: MemoryOrchestrationRegistry, settings: SettingsService,
  harness: Pick<Harness, "atIdleBoundary">, enabled: boolean): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "memory-orchestration", admin: true,
      help: "Memory behavior: status | use <registered-name> | disable (provider/tools unchanged)",
      async run(args) {
        const [action = "status", name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status" && !name) return JSON.stringify({ active: registry.active,
          desired: settings.effective().memory?.orchestration ?? "default", available: [...registry.names(), "none"], enabled });
        const selected = action === "use" && name && !rest.length ? name :
          action === "disable" && !name ? "none" : null;
        if (selected === null) throw Error("Use status | use <name> | disable");
        await harness.atIdleBoundary(async () => {
          const target = selected;
          registry.validate(target);
          if (!enabled && target !== "none") throw Error("Memory disabled at startup; restart required to enable it");
          await settings.setMemory({ orchestration: selected });
          registry.select(enabled ? target : "none");
        });
        return `Memory orchestration saved and applied: ${registry.active}. Provider and tools unchanged.`;
      },
    });
  } };
}
