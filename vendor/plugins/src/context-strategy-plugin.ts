// SPDX-License-Identifier: Apache-2.0
import type { PluginModule } from "./plugins.js";
import type { PureStrategy } from "./pure-strategy.js";
import type { SettingsService } from "./settings.js";
import type { ContextMaintenance } from "./context-maintenance.js";
import type { Harness } from "./harness.js";

/** Trusted local code selection is administrative; host authority is unchanged. */
export function contextStrategyPlugin<T>(holder: PureStrategy<T>, settings: SettingsService,
  harness: Pick<Harness, "atIdleBoundary">, maintenance: Pick<ContextMaintenance, "atStrategyBoundary">): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "context-strategy", admin: true,
      help: "Context prompt: status | use <module> | disable | baseline | reload",
      async run(args) {
        const [action = "status", name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status" && !name) return JSON.stringify({
          active: holder.selection === undefined ? "baseline" : holder.selection,
          enabled: holder.current !== undefined, desired: settings.snapshot().contextStrategy ??
            (settings.snapshot().contextStrategy === null ? null : "baseline"),
        });
        if (rest.length || (action === "use" ? !name : !!name) || !["use", "disable", "baseline", "reload"].includes(action)) {
          throw Error("Use status | use <module> | disable | baseline | reload");
        }
        await harness.atIdleBoundary(() => maintenance.atStrategyBoundary(async () => {
          const selection = action === "use" ? name! : action === "disable" ? null :
            action === "reload" ? holder.selection : undefined;
          await holder.change(selection, selected => settings.setContextStrategy(selected));
        }));
        return "Context strategy saved and applied. Host authorization unchanged.";
      },
    });
  } };
}
