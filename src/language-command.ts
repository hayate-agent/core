import { languageTag, message, resolveLanguage, type LanguagePolicy } from "./language.js";
export interface LanguageSettings {
  get(): LanguagePolicy;
  update(change: (value: LanguagePolicy) => LanguagePolicy): Promise<void>;
}
export async function languageCommand(args: string, sessionKey: string, settings: LanguageSettings | undefined, admin: boolean): Promise<string> {
  const locale = resolveLanguage(settings?.get(), { kind: "system" });
  if (!settings) return message(locale, "language.unavailable");
  const words = args.trim().split(/\s+/).filter(Boolean);
  const status = () => message(resolveLanguage(settings.get(), { kind: "system" }), "language.status", { settings: JSON.stringify(admin ? { default: "en", ...settings.get() }
    : { conversation: resolveLanguage(settings.get(), { kind: "conversation", sessionKey }) }) });
  if (!words.length || (words.length === 1 && words[0] === "status")) return status();
  if (!admin) return message(locale, "command.adminOnly");
  const [scope, key, value] = words;
  if ((["mcp", "job"].includes(scope) ? words.length !== 3 : words.length !== 2) || !["default", "system", "background", "conversation", "mcp", "job"].includes(scope)) return message(locale, "language.help");
  let tag: string | undefined;
  try { const raw = ["mcp", "job"].includes(scope) ? value : key; tag = raw === "reset" ? undefined : languageTag(raw); }
  catch { return message(locale, "language.invalid"); }
  // Never catch persistence failures as user syntax errors or acknowledge an unsaved setting.
  await settings.update(current => {
    if (["mcp", "job", "conversation"].includes(scope)) {
      const field = scope === "mcp" ? "mcp" : scope === "job" ? "jobs" : "conversations", name = scope === "conversation" ? sessionKey : key;
      current[field] = { ...current[field] };
      if (tag) Object.defineProperty(current[field], name, { value: tag, configurable: true, enumerable: true, writable: true });
      else delete current[field]![name];
    } else {
      const field = scope as "default" | "system" | "background";
      if (tag) current[field] = tag; else delete current[field];
    }
    return current;
  });
  return `${message(resolveLanguage(settings.get(), { kind: "system" }), "language.changed")}\n${status()}`;
}
