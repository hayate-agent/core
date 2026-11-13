import type { PluginModule } from "./plugins.js";
import { languageTag, resolveLanguage, type LanguagePolicy, type LanguageScope } from "./language.js";
/** Read-only, versioned localization service. Plugins own their catalogs, not a second language resolver. */
export function languageService(get: () => LanguagePolicy): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerService("language", 1, {
      resolve: (scope: LanguageScope) => resolveLanguage(get(), scope),
      render(catalogs: Record<string, Record<string, string>>, key: string, scope: LanguageScope, values: Record<string, string | number> = {}) {
        const tag = languageTag(resolveLanguage(get(), scope));
        const template = catalogs[tag]?.[key] ?? catalogs[tag.split("-")[0]]?.[key] ?? catalogs.en?.[key];
        if (typeof template !== "string") throw Error("Missing localized plugin message");
        return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name: string) => {
          if (!Object.hasOwn(values, name)) throw Error("Missing localized plugin message parameter");
          return String(values[name]);
        });
      },
    });
  } };
}
