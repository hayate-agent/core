// SPDX-License-Identifier: Apache-2.0
import type { Policy } from "./policies.js";
export interface PolicyOverride { module?: string; disabled?: boolean }
export type PolicyOverlay = Record<string, PolicyOverride>;
export interface PolicyInstance { policy: Policy; start?(): Promise<void>; stop?(): Promise<void> }
export interface PolicyModule {
  apiVersion: 1;
  /** Prepare only; no receivers or irreversible effects during create. */
  create(context: { home: string; cwd: string; agent: string }): Promise<PolicyInstance>;
}
export function validatePolicyOverlay(value: unknown): asserts value is PolicyOverlay {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid policy overlay");
  for (const [name, spec] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name) || !spec || typeof spec !== "object" || Array.isArray(spec) ||
        Object.keys(spec).some(k => !["module", "disabled"].includes(k)) ||
        (spec.module !== undefined && (typeof spec.module !== "string" || !spec.module.trim() || spec.module.length > 2000)) ||
        (spec.disabled !== undefined && typeof spec.disabled !== "boolean")) throw Error("Invalid policy override");
  }
}
