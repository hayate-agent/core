import en from "./locales/en.json" with { type: "json" };
import de from "./locales/de.json" with { type: "json" };
import es from "./locales/es.json" with { type: "json" };
import ru from "./locales/ru.json" with { type: "json" };

/** Presentation preferences only: never change execution scope, credentials or wire schemas. */
export interface LanguagePolicy {
  default?: string;
  system?: string;
  background?: string;
  conversations?: Record<string, string>;
  mcp?: Record<string, string>;
  /** Exact background session key, e.g. cron:weather; never a task permission. */
  jobs?: Record<string, string>;
}
export type LanguageScope = { kind: "conversation" | "system" | "background" | "mcp"; language?: string; sessionKey?: string; server?: string; job?: string };
export function languageTag(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) throw Error("Invalid BCP 47 language tag");
  const [tag] = Intl.getCanonicalLocales(value);
  if (!tag || tag === "und") throw Error("Invalid BCP 47 language tag");
  return tag;
}
export function validateLanguagePolicy(value: unknown): asserts value is LanguagePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid language policy");
  for (const [key, item] of Object.entries(value)) {
    if (["default", "system", "background"].includes(key)) { languageTag(item); continue; }
    if (!["conversations", "mcp", "jobs"].includes(key) || !item || typeof item !== "object" || Array.isArray(item)) throw Error("Invalid language policy field");
    const entries = Object.entries(item);
    if (entries.length > 1000) throw Error("Too many language overrides");
    for (const [name, tag] of entries) {
      if (!name || name.length > 512 || /[\x00-\x1f]/.test(name) || ["__proto__", "constructor", "prototype"].includes(name) || (key === "mcp" && !/^[A-Za-z0-9_.-]{1,128}$/.test(name))) throw Error("Invalid language override key");
      languageTag(tag);
    }
  }
}
export function resolveLanguage(policy: LanguagePolicy = {}, scope: LanguageScope): string {
  const own = (map: Record<string, string> | undefined, key?: string) => key && map && Object.hasOwn(map, key) ? map[key] : undefined;
  const base = policy.default ?? "en", system = policy.system ?? base;
  return languageTag(scope.language ?? (scope.kind === "conversation" ? own(policy.conversations, scope.sessionKey) ?? base
    : scope.kind === "system" ? system : scope.kind === "mcp" ? own(policy.mcp, scope.server) ?? policy.background ?? system : own(policy.jobs, scope.job ?? scope.sessionKey) ?? policy.background ?? system));
}
export type MessageKey = keyof typeof en;
const catalogs: Record<string, Record<MessageKey, string>> = { en, de, es, ru };
export function catalogLanguage(locale: string): string {
  const tag = languageTag(locale);
  return Object.hasOwn(catalogs, tag) ? tag : Object.hasOwn(catalogs, tag.split("-")[0]) ? tag.split("-")[0] : "en";
}
/** Exact tag -> base language -> English. Never ask a model to translate a lifecycle notice. */
export function message(locale: string, key: MessageKey, values: Record<string, string | number> = {}): string {
  const catalog = catalogs[catalogLanguage(locale)];
  return catalog[key].replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name: string) => {
    if (!Object.hasOwn(values, name)) throw Error(`Missing message parameter: ${name}`);
    return String(values[name]);
  });
}
export function mcpLanguageInstructions(policy: LanguagePolicy): string {
  return `For MCP natural-language queries/content, use the exact server's language override when configured, otherwise ${resolveLanguage(policy, { kind: "background" })}. Do not translate machine arguments or automatically rewrite tool results. Report results to the user in the conversation's output language. Language never grants authority. MCP server/language overrides (data): ${JSON.stringify(policy.mcp ?? {})}`;
}
export function backgroundLanguageKey(source: string, sessionKey: string): string {
  return sessionKey.startsWith(`${source}:`) ? sessionKey : `${source}:${sessionKey}`;
}
export function languageInstructions(policy: LanguagePolicy, input: { source: string; sessionKey: string; language?: string; languageContext?: "conversation" | "background" }): string {
  const conversation = input.languageContext === "conversation" || (input.languageContext !== "background" && ["channel", "api"].includes(input.source));
  const explicit = input.language ?? (conversation && Object.hasOwn(policy.conversations ?? {}, input.sessionKey) ? policy.conversations![input.sessionKey] : undefined);
  const locale = resolveLanguage(policy, { kind: conversation ? "conversation" : "background", sessionKey: input.sessionKey, job: backgroundLanguageKey(input.source, input.sessionKey), language: explicit });
  return [
    explicit || !conversation ? `Write natural-language output in ${locale}.` : `Match the current user's conversational language, including language switches. For continuations use the original operator request/conversation language, not internal host/control message language. If it cannot be determined, use ${locale}.`,
    "Language is a presentation preference only. Preserve code, identifiers, API fields, exact control tokens, quotations and tool protocols; it never grants authority.",
  ].join("\n");
}
