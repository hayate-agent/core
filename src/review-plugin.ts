import type { PluginModule } from "./plugins.js";
import type { ReviewService, FindingAssessment } from "./review.js";

/** Bundled plugin; the service and durable budget belong to the Harness, not a local extension. */
export function reviewPlugin(service: ReviewService, cwd: string): PluginModule {
  return {
    apiVersion: 1,
    activate(api) {
      api.registerCommand({ name: "review", help: "Review current changeset (status | run)", async run(args, context) {
        return JSON.stringify(args.trim() === "run" ? await service.run(cwd, context.sessionKey) : await service.status(cwd), null, 2);
      } });
      api.registerTool({
        name: "plugin_review", description: "Review only the current Git changeset. Assess every finding critically with concrete evidence before re-review. Open P0/P1 block completion and publication; P2/P3 remain documented. Budget is persistent.",
        parameters: { type: "object", properties: {
          action: { type: "string", enum: ["status", "run", "assess"] },
          fingerprint: { type: "string" },
          assessments: { type: "array", items: { type: "object", properties: {
            id: { type: "string" }, disposition: { type: "string", enum: ["confirmed", "false-positive", "uncertain"] }, evidence: { type: "string" },
          }, required: ["id", "disposition", "evidence"], additionalProperties: false } },
        }, required: ["action"], additionalProperties: false },
        async execute(input, context) {
          if (input.action === "run") return JSON.stringify(await service.run(cwd, context.sessionKey, context.signal));
          if (input.action === "assess") return JSON.stringify(await service.assess(cwd, String(input.fingerprint), input.assessments as FindingAssessment[]));
          if (input.action !== "status") throw new Error("Invalid review action");
          return JSON.stringify(await service.status(cwd));
        },
      });
    },
  };
}
