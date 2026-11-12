import { randomUUID } from "node:crypto";
import type { PluginModule } from "./plugins.js";
import type { SoftwareUpdateAction, SoftwareUpdateStatus } from "./software-updates.js";

/** Only the external foreground owner performs git/npm/selection. A command or
 * tool returns its scheduling receipt before any checkpoint can stop that turn. */
export function requestSoftwareUpdate(action: SoftwareUpdateAction): Promise<SoftwareUpdateStatus> {
  if (!process.send || !process.connected) return Promise.resolve({ phase: "external-owner", detail: "No native foreground owner; use the configured deployment owner", updatedAt: Date.now() });
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => { clearTimeout(timer); process.off("message", receive); };
    const receive = (message: unknown) => {
      const value = message as { type?: unknown; id?: unknown; status?: SoftwareUpdateStatus };
      if (value?.type !== "hayate-software-status" || value.id !== id || !value.status) return;
      cleanup(); resolve(value.status);
      try { process.send!({ type: "hayate-software-ack", id }, () => {}); } catch {}
    };
    const timer = setTimeout(() => { cleanup(); reject(Error("Native lifecycle owner did not acknowledge request; inspect status before retrying")); }, 3000);
    process.on("message", receive);
    try { process.send!({ type: "hayate-software-request", id, action }, error => {
      if (error) { cleanup(); reject(Error("Native lifecycle request could not be delivered")); }
    }); } catch { cleanup(); reject(Error("Native lifecycle owner disconnected")); }
  });
}

export function softwareLifecyclePlugin(restart: () => Promise<void>,
  authorize: (action: string, key: string) => boolean = () => false): PluginModule {
  return { apiVersion: 1, activate(api) {
    api.registerTool({ name: "plugin_software_update",
      description: "Native agent lifecycle: inspect software status, check configured Core/Plugins/WebUI Git sources, or schedule a validated native installation and durable restart. The external foreground owner executes it; do not write ad-hoc restart/update scripts or wait for all business work to finish. Use only within operator-authorized maintenance or configured automatic updates. Does not change repositories/config, update containers, cancel tasks or replay external effects. Restart fences new input and checkpoints all owners within the configured total deadline (default60s). Scheduling is not installation completion: inspect status for the retained outcome.",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["status", "check", "install", "restart"] } }, required: ["action"], additionalProperties: false },
      async execute(input, context) {
        if (["install", "restart"].includes(input.action as string) && !authorize(input.action as string, context.sessionKey))
          throw Error("Operator-authorized maintenance required");
        if (input.action === "restart") { await restart(); return "Durable restart initiated; current work retained, new ingress fenced"; }
        if (!["status", "check", "install"].includes(input.action as string)) throw Error("Invalid lifecycle action");
        return JSON.stringify(await requestSoftwareUpdate(input.action as SoftwareUpdateAction));
      },
    });
  } };
}
