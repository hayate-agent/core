import type { PluginModule } from "./plugins.js";
import type { PureStrategy } from "./pure-strategy.js";
import type { NightlyStrategy } from "./nightly-strategy.js";
import type { SettingsService } from "./settings.js";
import type { ImprovementController } from "./improvement.js";

/** Trusted code selection only between fully reported nights. */
export function nightlyStrategyPlugin(holder: PureStrategy<NightlyStrategy>, settings: SettingsService,
  controller: Pick<ImprovementController, "atStrategyBoundary">): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerCommand({ name: "nightly-strategy", admin: true,
      help: "Nightly strategy: status | use <module> | disable | baseline | reload (between nights)",
      async run(args) {
        const [action = "status", name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (action === "status" && !name) return JSON.stringify({
          active: holder.selection === undefined ? "baseline" : holder.selection,
          enabled: holder.current !== undefined,
          desired: settings.snapshot().nightlyStrategy === undefined ? "baseline" : settings.snapshot().nightlyStrategy,
        });
        if (rest.length || (action === "use" ? !name : !!name) || !["use", "disable", "baseline", "reload"].includes(action)) {
          throw Error("Use status | use <module> | disable | baseline | reload");
        }
        await controller.atStrategyBoundary(async () => {
          const selection = action === "use" ? name! : action === "disable" ? null :
            action === "reload" ? holder.selection : undefined;
          await holder.change(selection, selected => settings.setNightlyStrategy(selected));
        });
        return "Nightly strategy saved and applied. Host window, budget and evaluator unchanged.";
      },
    });
  } };
}
