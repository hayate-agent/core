import type { Harness } from "./harness.js";
import type { OperatorRules } from "./operator-rules.js";
import type { PluginModule } from "./plugins.js";

export function operatorRulesPlugin(harness: Harness, rules: OperatorRules,
  isOperator: (key: string) => boolean, authorize: (evidence: object, signal?: AbortSignal) => Promise<boolean>): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_operator_rules",
      description: "Agent-wide durable operator preferences, independent of chat memory and skills. List/show exact retained sources. For an actual enduring operator correction, save its EXACT instruction clause (not your paraphrase, not a quoted assistant assertion) with the current book revision; replace the same key for a correction rather than keeping conflicting rules. Semantic authorization checks the current authentic input. remove requires an explicit operator revocation. Successful persistence is not proof a separate skill or external document was corrected. Children may list but cannot change rules.",
      parameters: { type: "object", additionalProperties: false, required: ["action"], properties: {
        action: { type: "string", enum: ["list", "set", "remove"] }, key: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$", description: "Stable rule key: lowercase letters, digits and hyphens; no dots or underscores. Reuse the same key when correcting a rule." }, text: { type: "string", maxLength: 2000 }, expectedRevision: { type: "integer", minimum: 0 },
      } },
      async execute(args, ctx) {
        if (args.action === "list") return JSON.stringify(rules.snapshot());
        if (!["set", "remove"].includes(String(args.action))) throw Error("Invalid operator rule action");
        const state = harness.sessions.get(ctx.sessionKey), input = state?.current;
        if (!input || !isOperator(ctx.sessionKey) || state?.cancelling === input) throw Error("Authentic current operator input required");
        const stillCurrent = () => harness.sessions.get(ctx.sessionKey)?.current === input && !ctx.signal?.aborted &&
          !harness.stopping && !harness.sessions.get(ctx.sessionKey)?.stopPending && harness.sessions.get(ctx.sessionKey)?.cancelling !== input;
        return JSON.stringify(await rules.change(input, { key: args.key as string, text: args.text as string | undefined,
          expectedRevision: args.expectedRevision as number, remove: args.action === "remove" }, evidence => authorize(evidence, ctx.signal), stillCurrent));
      },
    });
  } };
}
