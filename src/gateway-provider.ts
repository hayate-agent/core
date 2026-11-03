import type { Address, Channel } from "./types.js";

/** Trusted gateway modules: native Channel routing preserves durable conversation identity. */
export interface GatewayInstance {
  channel: Channel;
  home?: Address;
  /** Optional remote administration defaults; operator configuration takes precedence. */
  approvers?: string[];
}
export interface GatewayFactoryContext {
  home: string;
  agent: string;
  approvers: string[];
  admins?: string[];
}
export interface GatewayModule {
  apiVersion: 1;
  /** Trusted assertion: create is inert, all work is host-owned ingress/delivery,
   * and Channel.stop drains every remaining resource. Not a sandbox. */
  updateAdmission?: "foreground-owned";
  create(context: GatewayFactoryContext): Promise<GatewayInstance | undefined>;
}
export interface GatewayOverride { module?: string; disabled?: boolean }
export type GatewayOverlay = Record<string, GatewayOverride>;
export function validateGatewayOverlay(value: unknown): asserts value is GatewayOverlay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid gateway plugin overlay");
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name) || ["console", "api", "subagents"].includes(name) || !spec || typeof spec !== "object" || Array.isArray(spec)) throw Error("Invalid gateway plugin ID");
    for (const [key, v] of Object.entries(spec)) {
      if (key === "module" && typeof v === "string" && v.length && v.length <= 2000) continue;
      if (key === "disabled" && typeof v === "boolean") continue;
      throw Error("Invalid gateway plugin override");
    }
  }
}
