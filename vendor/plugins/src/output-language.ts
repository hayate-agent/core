/** Optional v1 Core service; old hosts retain English without a second policy engine. */
export interface OutputLanguageScope { kind: "conversation" | "system" | "background" | "mcp"; language?: string; sessionKey?: string; server?: string }
interface Services { get(name: string): { version: number; implementation: unknown } | undefined }
export function outputLanguage(services: Services | undefined, scope: OutputLanguageScope): string {
  const service = services?.get("language");
  if (service?.version === 1) return (service.implementation as { resolve(scope: OutputLanguageScope): string }).resolve(scope);
  if (!scope.language) return "en";
  return checkedOutputLanguage(scope.language);
}
export function checkedOutputLanguage(value: string): string {
  if (value.length > 64 || !/^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)) throw Error("Invalid output language");
  const [tag] = Intl.getCanonicalLocales(value);
  if (!tag || tag === "und") throw Error("Invalid output language");
  return tag;
}
