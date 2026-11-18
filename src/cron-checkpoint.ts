import type { Harness } from "./harness.js";
import type { PluginModule } from "./plugins.js";

export interface CronCheckpoint {
  version: 1;
  /** Exact configured prompt hash; source/scope changes never reuse old cursors silently. */
  scope: string;
  revision: number;
  runId: string;
  tools: string[];
  sources: Array<{ id: string; locator: string; cursor?: string; observedAt: string }>;
  pending: string[];
  evidence: string[];
}
export function validCronCheckpoint(value: unknown): value is CronCheckpoint {
  const c = value as CronCheckpoint;
  const strings = (v: unknown, count: number, length: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(x => typeof x === "string" && x.length <= length);
  return !!c && c.version === 1 && /^[a-f0-9]{64}$/.test(c.scope) && Number.isSafeInteger(c.revision) && c.revision >= 0 &&
    typeof c.runId === "string" && c.runId.length <= 200 && strings(c.tools, 12, 160) && c.tools.every(t => /^[a-zA-Z0-9_.:-]+$/.test(t)) &&
    strings(c.pending, 12, 500) && strings(c.evidence, 12, 500) && Array.isArray(c.sources) && c.sources.length <= 12 &&
    c.sources.every(s => s && typeof s.id === "string" && s.id.length > 0 && s.id.length <= 120 && typeof s.locator === "string" && s.locator.length <= 500 &&
      (s.cursor === undefined || typeof s.cursor === "string" && s.cursor.length <= 500) && typeof s.observedAt === "string" && Number.isFinite(Date.parse(s.observedAt)));
}
export function cronCheckpointPlugin(harness: Harness): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_cron_checkpoint",
      description: "Retain a small source/work checkpoint for this exact configured cron job across fresh occurrences. Read the supplied checkpoint first; reuse source IDs/locators and permitted known tools instead of rediscovering everything. Stage only actually observed source cursors, exact evidence references and unfinished items; observed cursors are NOT proof all items were processed. Pending work must remain explicit. No secrets, credentials, raw responses or instructions. Publication uses the existing successful turn settlement; a tool acknowledgement alone is not committed progress. On scope changes reconcile the historical checkpoint rather than reusing its cursor blindly.",
      parameters: { type: "object", additionalProperties: false, required: ["sources", "pending", "evidence"], properties: {
        sources: { type: "array", maxItems: 12, items: { type: "object", additionalProperties: false, required: ["id", "locator", "observedAt"], properties: { id: { type: "string", maxLength: 120 }, locator: { type: "string", maxLength: 500 }, cursor: { type: "string", maxLength: 500 }, observedAt: { type: "string" } } } },
        pending: { type: "array", maxItems: 12, items: { type: "string", maxLength: 500 } }, evidence: { type: "array", maxItems: 12, items: { type: "string", maxLength: 500 } },
      } }, async execute(args, ctx) {
        harness.stageCronCheckpoint(ctx.sessionKey, args);
        return "Checkpoint staged for this occurrence. Not yet committed; existing effect and delivery receipts remain authoritative.";
      },
    });
  } };
}
