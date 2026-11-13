import { message } from "./language.js";
import { readFileSync } from "node:fs";
import { BUILD_INFO } from "./build-info.js";

export interface ComponentVersion { version?: string; revision?: string; coreBundle?: boolean; gatewayActive?: boolean }
export interface SoftwareVersions {
  version: string;
  revision?: string;
  components?: { plugins?: ComponentVersion; webui?: ComponentVersion; webPackage?: ComponentVersion };
}
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const version = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]{0,100})?$/.test(value);

/** Local installed payload facts only. No network, selected-but-not-active plan,
 * or latest-release lookup can relabel the current runtime's component versions.
 */
export function readSoftwareVersions(core: { version: string; revision?: string } = BUILD_INFO,
  read: (relative: string) => unknown = relative => JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), "utf8")),
  _webuiActive = false): SoftwareVersions {
  const result: SoftwareVersions = { ...core, components: {} };
  try {
    const lock = read("plugins.lock.json") as { schema?: number; revision?: unknown };
    if (lock.schema === 1 && sha(lock.revision)) {
      // Built-in adapters are released as part of this exact Core bundle. The
      // independent overlay-v* tags do not version these locked source files.
      result.components!.plugins = { version: core.version, revision: lock.revision, coreBundle: true };
    }
  } catch { /* Older images may not carry component provenance. Never invent it. */ }
  // Plugins removed the frontend. The API-only dashboard gateway still uses
  // channel name "webui"; that is NOT proof of a bundled/running frontend.
  // Ignore stale optional-plugins provenance left by older installations.
  try {
    const source = read("dist/source-build-info.json") as { revision?: unknown; webPackage?: ComponentVersion };
    const web = source.webPackage;
    if (source.revision === core.revision && web && version(web.version) && sha(web.revision))
      result.components!.webPackage = { version: web.version, revision: web.revision };
  } catch { /* Docker/legacy installations may not contain a separate Web package. */ }
  return result;
}

export function formatSoftwareVersions(info: SoftwareVersions, language = "en"): string {
  const component = (value?: ComponentVersion) => value
    ? `${value.version ?? message(language, "software.unknownVersion")}${value.revision ? ` · ${value.revision.slice(0, 12)}` : ""}`
    : message(language, "software.noData");
  return [
    `Core: ${component(info)}`,
    `Plugins${info.components?.plugins?.coreBundle ? ` (${message(language, "software.bundle")})` : ""}: ${component(info.components?.plugins)}`,
    ...(info.components?.webPackage ? [`${message(language, "software.dashboard")}: ${component(info.components.webPackage)}`] : []),
  ].join("\n");
}
