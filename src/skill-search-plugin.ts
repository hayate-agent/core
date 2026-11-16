import type { SkillCatalog } from "./skill-catalog.js";
import type { PluginModule } from "./plugins.js";

/**
 * Late skill discovery: instead of injecting every skill's metadata into the
 * prompt each turn, the model can query this lightweight tool to find matching
 * skills on demand. Full instructions are still loaded by the runtime when the
 * task calls for the named skill. Search results provide the exact catalog path
 * so the agent can read the matching skill without guessing or scanning roots.
 */
export function skillSearchPlugin(catalog: SkillCatalog): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({
      name: "plugin_skill_search",
      description: "Search available skills by keyword; return matching names, descriptions and SKILL.md paths. Read the relevant path for the full instructions, and update it with normal tools when appropriate and in scope.",
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
        // Skills may be created or edited by normal tools during a session.
        // Search must reflect the current sources, not just the startup snapshot.
        await catalog.refresh();
        const q = String(input.query).trim().toLowerCase();
        const limit = Math.max(1, Math.min(20, Number(input.limit) || 8));
        const hits = catalog.skills
          .filter((s) => q.length > 0 && (s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)))
          .slice(0, limit)
          .map((s) => ({ name: s.name, description: s.description, filePath: s.filePath }));
        return hits.length
          ? `Matching skills:\n${JSON.stringify(hits, null, 2)}\nRead the named SKILL.md at its filePath for full instructions; automatic loading is not guaranteed.`
          : "No matching skills. Try broader keywords from the task (e.g. 'web', 'search', 'test', 'pdf').";
      },
    });
  } };
}
