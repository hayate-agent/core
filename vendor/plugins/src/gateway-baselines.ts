/** Immutable default module catalog; local overrides remain owned by Core. */
export function bundledGatewayModules(): Record<string, string> {
  return { matrix: new URL(import.meta.url.endsWith(".ts") ? "./matrix-gateway.ts" : "./matrix-gateway.js", import.meta.url).href };
}
