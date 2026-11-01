import type { PluginModule } from "./plugins.js";
import type { ImprovementController } from "./improvement.js";
import type { ExperimentSpec } from "./improvement-experiments.js";
export function improvementPlugin(service: ImprovementController): PluginModule {
  return { apiVersion: 1, activate(api) {
      api.registerTool({ name: "plugin_improvement_evaluate", description: "Measure a nightly experiment against its baseline using an infrastructure-pinned evaluator. An improved verdict is evidence, not authorization to merge.",
        parameters: { type: "object", properties: { baseline: { type: "string" }, candidate: { type: "string" }, hypothesis: { type: "string" }, metric: { type: "string" }, direction: { type: "string", enum: ["lower", "higher"] }, minimumDelta: { type: "number", minimum: 0 } }, required: ["baseline", "candidate", "hypothesis", "metric", "direction", "minimumDelta"], additionalProperties: false },
        execute: (input, ctx) => service.evaluate(ctx.sessionKey, api.cwd, input as unknown as ExperimentSpec),
      });
  } };
}
