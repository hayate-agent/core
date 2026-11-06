import type { PluginModule } from "./plugins.js";
import type { CompactionSelection } from "./compaction.js";
import type { SettingsService } from "./settings.js";
import type { Harness } from "./harness.js";
import type { ContextMaintenance } from "./context-maintenance.js";

/** Registered wrappers only; native removes the optional wrapper, not compaction. */
export function compactionStrategyPlugin(current: () => CompactionSelection, settings: SettingsService,
  harness: Pick<Harness, "atIdleBoundary">, maintenance: Pick<ContextMaintenance, "atStrategyBoundary">): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "compaction-strategy", admin: true,
      help: "Compaction wrapper: status | use <registered-name> | baseline (native removes wrapper)",
      async run(args) {
        const [action = "status", name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        const selection = current();
        if (action === "status" && !name) return JSON.stringify({ active: selection.active,
          baseline: selection.baseline, desired: settings.snapshot().compactionStrategy ?? "baseline", available: selection.names() });
        if (rest.length || (action === "use" ? !name : !!name) || !["use", "baseline"].includes(action)) {
          throw Error("Use status | use <registered-name> | baseline; use native to remove a wrapper");
        }
        await harness.atIdleBoundary(() => maintenance.atStrategyBoundary(() =>
          selection.change(action === "use" ? name : undefined, value => settings.setCompactionStrategy(value))));
        return `Compaction strategy saved and applied: ${selection.active}. Native overflow and summary unchanged.`;
      },
    });
  } };
}
