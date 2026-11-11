import { progressMode, type ProgressMode } from "./channels/progress.js";

export interface ConversationRule {
  activation?: "mentions" | "threads" | "open" | "disabled";
  replyLocation?: "thread" | "channel";
  /** Native immutable user IDs, not names or admin identities. Empty denies all. */
  users?: "*" | string[];
}
export interface ConversationPolicy {
  defaults?: ConversationRule;
  /** Applies to ingress, directory and explicit sends; never auto-joins channels. */
  allowedChannels?: "*" | string[];
  channels?: Record<string, ConversationRule>;
}

export function validateConversationPolicy(value: unknown): asserts value is ConversationPolicy {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const ids = (v: unknown) => v === "*" || Array.isArray(v) && v.length <= 256 && v.every(id => typeof id === "string" && !!id.trim() && id.length <= 256);
  const rule = (v: unknown) => {
    if (!object(v)) throw Error("Invalid conversation rule");
    for (const [key, field] of Object.entries(v)) {
      if (key === "activation" && ["mentions", "threads", "open", "disabled"].includes(field as string)) continue;
      if (key === "replyLocation" && ["thread", "channel"].includes(field as string)) continue;
      if (key === "users" && ids(field)) continue;
      throw Error("Invalid conversation rule field");
    }
  };
  if (!object(value)) throw Error("Invalid conversation policy");
  for (const [key, field] of Object.entries(value)) {
    if (key === "defaults") rule(field);
    else if (key === "allowedChannels" && ids(field)) continue;
    else if (key === "channels" && object(field) && Object.keys(field).length <= 256) {
      for (const [id, settings] of Object.entries(field)) {
        if (!id.trim() || id.length > 256 || ["__proto__", "constructor", "prototype"].includes(id)) throw Error("Invalid conversation channel ID");
        rule(settings);
      }
    } else throw Error("Invalid conversation policy field");
  }
}

export function mergeConversationPolicy(base?: ConversationPolicy, override?: ConversationPolicy): ConversationPolicy | undefined {
  if (!base && !override) return undefined;
  const channels = { ...base?.channels };
  for (const [id, rule] of Object.entries(override?.channels ?? {})) channels[id] = { ...channels[id], ...rule };
  return { defaults: { ...base?.defaults, ...override?.defaults },
    allowedChannels: override?.allowedChannels ?? base?.allowedChannels ?? "*", channels };
}

export interface GatewaySettings {
  progress: ProgressMode;
  statusReactions: boolean;
  /** Opt-in host recovery diagnostics, never substantive replies or approvals. */
  recoveryDiagnostics?: boolean;
  conversation?: ConversationPolicy;
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
      } else if (key === "conversation" && !root) {
        validateConversationPolicy(val);
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

export function assertGatewayConversationSupport(channel: Pick<import("./types.js").Channel, "name" | "conversationPolicy" | "configureGateway">, config?: GatewayConfig): void {
  if (gatewaySettings(config, channel.name).conversation &&
      (channel.conversationPolicy !== 1 || !channel.configureGateway)) throw Error(`Gateway ${channel.name} does not support configured conversation policy`);
}
export function applyGatewaySettings(channel: Pick<import("./types.js").Channel, "name" | "conversationPolicy" | "configureGateway">, config?: GatewayConfig): void {
  assertGatewayConversationSupport(channel, config);
  channel.configureGateway?.(gatewaySettings(config, channel.name));
}

/** Transport-independent defaults; explicit false/off override inherited values. */
export function gatewaySettings(config: GatewayConfig | undefined, name: string): GatewaySettings {
  const override = config?.overrides && Object.hasOwn(config.overrides, name) ? config.overrides[name] : undefined;
  return {
    progress: override?.progress ?? config?.progress ?? "off",
    statusReactions: override?.statusReactions ?? config?.statusReactions ?? false,
    recoveryDiagnostics: override?.recoveryDiagnostics ?? config?.recoveryDiagnostics ?? false,
    ...(override?.conversation ? { conversation: structuredClone(override.conversation) } : {}),
  };
}
