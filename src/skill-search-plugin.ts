import type { SkillCatalog } from "./skill-catalog.js";
import type { PluginModule } from "./plugins.js";

/**
 * Late skill discovery: instead of injecting every skill's metadata into the
 * prompt each turn, the model can query this lightweight tool to find matching
 * skills on demand. Full instructions are still loaded by the runtime when the
 * task calls for the named skill. The tool returns names + descriptions only,
 * never file paths or full bodies, so it stays small and prefix-cache friendly.
 */
export function skillSearchPlugin(catalog: SkillCatalog): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({
      name: "plugin_skill_search",
      description: "Search the agent's available skills by keyword and return matching skill names + descriptions. Call this when a task might match a documented skill (e.g. 'web', 'search', 'pdf', 'test') to discover it on demand instead of listing every skill.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 256, description: "Keyword to match against skill names and descriptions." },
          limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input) {
        const q = String(input.query).trim().toLowerCase();
        const limit = Math.max(1, Math.min(20, Number(input.limit) || 8));
        const hits = catalog.skills
          .filter((s) => q.length > 0 && (s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)))
          .slice(0, limit)
          .map((s) => ({ name: s.name, description: s.description }));
        return hits.length
          ? `Matching skills:\n${JSON.stringify(hits, null, 2)}\nRead the named SKILL.md for full instructions; the runtime loads it when the task calls for it.`
          : "No matching skills. Try broader keywords from the task (e.g. 'web', 'search', 'test', 'pdf').";
      },
    });
  } };
}
