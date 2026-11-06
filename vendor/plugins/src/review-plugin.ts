import type { PluginModule } from "./plugins.js";
import type { ReviewService, FindingAssessment } from "./review.js";

/** Bundled plugin; the service and durable budget belong to the Harness, not a local extension. */
export function reviewPlugin(service: ReviewService, cwd: string): PluginModule {
  return {
    apiVersion: 1,
    activate(api) {
      api.registerCommand({ name: "review", admin: true, help: "Review current changeset (status | run | extend <id> <rounds> <base> <fingerprint> <reason>)", async run(args, context) {
        const [action, id, count, base, fingerprint, ...reason] = args.trim().split(/\s+/);
        if (action === "extend") {
          if (!id || !/^[1-9]\d*$/.test(count ?? "") || !base || !fingerprint || !reason.length) {
            throw new Error("Usage: /review extend <id> <rounds> <base> <fingerprint> <reason>");
          }
          return service.summarize(await service.extendBudget(cwd, {
            id, rounds: Number(count), base, fingerprint, reason: reason.join(" "),
            actor: context.sender ?? context.sessionKey,
          }));
        }
        if (action && action !== "run" && action !== "status") throw new Error("Unknown review command");
        return service.summarize(action === "run" ? await service.run(cwd, context.sessionKey) : await service.status(cwd));
      } });
      api.registerTool({
        name: "plugin_review", description: "Review only the current Git changeset. Prioritize P0/P1 and assess them critically with concrete evidence before re-review. Only open P0/P1 block completion and publication; P2/P3 are optional documented follow-ups and never block. Budget is persistent.",
        parameters: { type: "object", properties: {
          action: { type: "string", enum: ["status", "run", "assess"] },
          fingerprint: { type: "string" },
          assessments: { type: "array", items: { type: "object", properties: {
            id: { type: "string" }, disposition: { type: "string", enum: ["confirmed", "false-positive", "uncertain"] }, evidence: { type: "string" },
          }, required: ["id", "disposition", "evidence"], additionalProperties: false } },
        }, required: ["action"], additionalProperties: false },
        async execute(input, context) {
          if (input.action === "run") return service.summarize(await service.run(cwd, context.sessionKey, context.signal));
          if (input.action === "assess") return service.summarize(await service.assess(cwd, String(input.fingerprint), input.assessments as FindingAssessment[]));
          if (input.action !== "status") throw new Error("Invalid review action");
          return service.summarize(await service.status(cwd));
        },
      });
    },
  };
}
