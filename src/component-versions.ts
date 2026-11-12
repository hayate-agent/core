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
  webuiActive = false): SoftwareVersions {
  const result: SoftwareVersions = { ...core, components: {} };
  try {
    const lock = read("plugins.lock.json") as { schema?: number; revision?: unknown };
    if (lock.schema === 1 && sha(lock.revision)) {
      // Built-in adapters are released as part of this exact Core bundle. The
      // independent overlay-v* tags do not version these locked source files.
      result.components!.plugins = { version: core.version, revision: lock.revision, coreBundle: true };
    }
  } catch { /* Older images may not carry component provenance. Never invent it. */ }
  try {
    const asset = read("dist/optional-plugins/webui/provenance.json") as { schema?: number; version?: unknown; plugin?: { revision?: unknown } };
    if (asset.schema === 1 && sha(asset.plugin?.revision)) result.components!.webui = {
      version: version(asset.version) ? asset.version : undefined, revision: asset.plugin.revision, gatewayActive: webuiActive,
    };
  } catch { /* A separately hosted central WebUI cannot be inferred from Core. */ }
  try {
    const source = read("dist/source-build-info.json") as { revision?: unknown; webPackage?: ComponentVersion };
    const web = source.webPackage;
    if (source.revision === core.revision && web && version(web.version) && sha(web.revision))
      result.components!.webPackage = { version: web.version, revision: web.revision };
  } catch { /* Docker/legacy installations may not contain a separate Web package. */ }
  return result;
}

export function formatSoftwareVersions(info: SoftwareVersions): string {
  const component = (value?: ComponentVersion) => value
    ? `${value.version ?? "Version nicht ausgewiesen"}${value.revision ? ` · ${value.revision.slice(0, 12)}` : ""}`
    : "Versionsdaten nicht vorhanden";
  return [
    `Core: ${component(info)}`,
    `Plugins${info.components?.plugins?.coreBundle ? " (Core-Bundle)" : ""}: ${component(info.components?.plugins)}`,
    `Web (mitgeliefert${info.components?.webui?.gatewayActive === false ? ", Gateway inaktiv" : ""}): ${component(info.components?.webui)}`,
    ...(info.components?.webPackage ? [`Web (separates Paket, installiert): ${component(info.components.webPackage)}`] : []),
  ].join("\n");
}
