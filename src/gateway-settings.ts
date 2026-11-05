import { progressMode, type ProgressMode } from "./channels/progress.js";

export interface GatewaySettings {
  progress: ProgressMode;
  statusReactions: boolean;
  /** Opt-in host recovery diagnostics, never substantive replies or approvals. */
  recoveryDiagnostics?: boolean;
}
export interface GatewayConfig {
  progress?: ProgressMode;
  statusReactions?: boolean;
  recoveryDiagnostics?: boolean;
  overrides?: Record<string, Partial<GatewaySettings>>;
}

export function validateGatewayConfig(value: unknown): asserts value is GatewayConfig | undefined {
  if (value === undefined) return;
  const validate = (v: unknown, root = false): void => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("gateways settings must be an object");
    for (const [key, val] of Object.entries(v)) {
      if (key === "progress") {
        if (typeof val !== "string") throw new Error("gateways.progress must be off, reduced or full");
        progressMode(val);
      } else if (key === "statusReactions" || key === "recoveryDiagnostics") {
        if (typeof val !== "boolean") throw new Error(`gateways.${key} must be a boolean`);
      } else if (key === "overrides" && root) {
        if (!val || typeof val !== "object" || Array.isArray(val)) throw new Error("gateways.overrides must be an object");
        for (const [name, settings] of Object.entries(val)) {
          if (!/^[a-z][a-z0-9_-]*$/.test(name)) throw new Error("Invalid gateway override name");
          validate(settings);
        }
      } else throw new Error(`Unknown gateways setting: ${key}`);
    }
  };
  validate(value, true);
}

/** Transport-independent defaults; explicit false/off override inherited values. */
export function gatewaySettings(config: GatewayConfig | undefined, name: string): GatewaySettings {
  const override = config?.overrides && Object.hasOwn(config.overrides, name) ? config.overrides[name] : undefined;
  return {
    progress: override?.progress ?? config?.progress ?? "off",
    statusReactions: override?.statusReactions ?? config?.statusReactions ?? false,
    recoveryDiagnostics: override?.recoveryDiagnostics ?? config?.recoveryDiagnostics ?? false,
  };
}
