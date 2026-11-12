import { isDeepStrictEqual } from "node:util";
import type { SettingsService, LocalSettings } from "./settings.js";
import type { GatewayManager } from "./gateway-manager.js";
import type { PolicyManager } from "./policy-manager.js";
import type { ExtensionManager } from "./extension-manager.js";

/** Enqueue only: waiting for an idle boundary inside beforeRequest deadlocks. */
export function pluginOverlayReload(settings: SettingsService, managers: {
  gateway: Pick<GatewayManager, "request" | "status">;
  policy: Pick<PolicyManager, "request" | "status">;
  extension: Pick<ExtensionManager, "request" | "status">;
}): () => Promise<void> {
  let attempted = settings.effective();
  return async () => {
    const desired = settings.desired();
    for (const [key, manager] of [
      ["gatewayPlugins", managers.gateway], ["policyPlugins", managers.policy], ["extensionPlugins", managers.extension],
    ] as const) {
      const old = attempted[key] ?? {};
      const next = desired[key] ?? {};
      for (const id of new Set([...Object.keys(old), ...Object.keys(next)])) {
        if (isDeepStrictEqual(old[id], next[id])) continue;
        const status = JSON.parse(manager.status());
        if (!status.errors?.[id] && !status.pending?.includes(id) &&
            isDeepStrictEqual(settings.effective()[key]?.[id], next[id])) continue;
        // Remember rejected attempts too. A changed desired value or explicit command retries.
        try { await manager.request(id); } catch { /* Manager status retains activation failures. */ }
      }
    }
    attempted = structuredClone(desired) as LocalSettings;
  };
}
