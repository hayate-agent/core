import { validatePolicyOverlay, type PolicyOverlay, type PolicyOverride } from "./policy-modules.js";
import { dispatcherConfig, type DispatcherConfig } from "./dispatcher-config.js";
import { validateGatewayOverlay, type GatewayOverlay, type GatewayOverride } from "./gateway-provider.js";
import { memoryConfig, type MemoryConfig } from "./memory.js";
import { validateGatewayConfig, type GatewayConfig } from "./gateway-settings.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { writeFileDurable } from "./durable.js";
import { pruningPolicy, type PruningPolicy } from "./tool-result-pruning.js";
import { contextPolicy, type ContextPolicy } from "./context-maintenance.js";
import { validateModelSetting, type ModelSetting } from "./model-settings.js";

/** Explicit runtime-writable allowlist; security policy and secrets are deliberately excluded. */
export interface LocalSettings {
  dispatcher?: Partial<DispatcherConfig>;
  gateways?: GatewayConfig;
  gatewayPlugins?: GatewayOverlay;
  policyPlugins?: PolicyOverlay;
  extensionPlugins?: PolicyOverlay;
  memory?: Partial<MemoryConfig>;
  model?: string;
  thinking?: string;
  review?: { model?: string; thinking?: string };
  contextMaintenance?: Partial<ContextPolicy>;
  toolResultPruning?: Partial<PruningPolicy>;
  skills?: { paths?: string[]; context?: "auto" | "lazy" | "off" };
}
export type SettingPath = "model" | "thinking" | "review.model" | "review.thinking";
const keys: Record<SettingPath, ModelSetting> = { model: "model", thinking: "thinking", "review.model": "reviewModel", "review.thinking": "reviewThinking" };
function validate(value: unknown, defaults: Partial<ContextPolicy> = {}, pruningDefaults: Partial<PruningPolicy> = {}, dispatcherDefaults: Partial<DispatcherConfig> = {}): asserts value is LocalSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local settings overlay");
  const data = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(data)) {
    if (key === "dispatcher") {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["enabled", "strategy", "concurrentRequests", "capacity", "retentionDays"].includes(key))) throw Error("Invalid dispatcher overlay");
      dispatcherConfig({ ...dispatcherDefaults, ...item });
    } else if (key === "policyPlugins" || key === "extensionPlugins") {
      validatePolicyOverlay(item);
    } else if (key === "gatewayPlugins") {
      validateGatewayOverlay(item);
    } else if (key === "memory") {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("Invalid memory overlay");
      if (Object.keys(item).some((k) => !["enabled", "provider", "orchestration", "autoCapture", "autoRecall", "scanSeconds", "maxEntries", "maxIndexBytes", "recallLimit", "embedding"].includes(k))) throw Error("Unsupported memory setting");
      memoryConfig(item);
    } else if (key === "gateways") {
      validateGatewayConfig(item);
    } else if (key === "toolResultPruning") {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid pruning overlay");
      pruningPolicy({ ...pruningDefaults, ...item });
    } else if (key === "contextMaintenance") {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid context policy overlay");
      const allowed = ["enabled", "checkEveryTurns", "assessPercent", "compactPercent", "cooldownTurns", "autoHandover"];
      if (Object.keys(item).some((k) => !allowed.includes(k))) throw new Error("Unsupported context setting");
      contextPolicy({ ...defaults, ...item });
    } else if (key === "skills") {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw Error("Invalid skills overlay");
      const skillItem = item as Record<string, unknown>;
      if (Object.keys(skillItem).some((k) => !["paths", "context"].includes(k))) throw Error("Unsupported skills setting");
      if (skillItem.paths !== undefined) {
        if (!Array.isArray(skillItem.paths) || skillItem.paths.some((p) => typeof p !== "string" || !p.trim())) throw Error("Invalid skills.paths");
      }
      if (skillItem.context !== undefined && !["auto", "lazy", "off"].includes(skillItem.context as string)) throw Error("Invalid skills.context");
    } else if (key === "review") {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid review settings overlay");
      for (const [field, v] of Object.entries(item)) {
        if (!["model", "thinking"].includes(field) || typeof v !== "string") throw new Error("Unsupported review setting");
        validateModelSetting(keys[`review.${field}` as SettingPath], v);
      }
    } else {
      if (!["model", "thinking"].includes(key) || typeof item !== "string") throw new Error("Unsupported local setting");
      validateModelSetting(keys[key as SettingPath], item);
    }
  }
}

/** One owner per Harness home; atomic serialized updates, published only after durable save. */
export class SettingsService {
  private overlay: LocalSettings = {};
  private ignored: Record<string, unknown> = Object.create(null);
  readonly diagnostics: string[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  revision = 0;
  constructor(readonly file: string, private readonly defaults: LocalSettings, private readonly warn: (message: string) => void = () => {}) {}
  async load(): Promise<void> {
    try {
      const data = parse(await readFile(this.file, "utf8"));
      if (!data || typeof data !== "object" || Array.isArray(data)) throw Error("Invalid local settings overlay");
      const supported = new Set(["dispatcher", "gateways", "gatewayPlugins", "policyPlugins", "extensionPlugins", "memory", "model", "thinking", "review", "contextMaintenance", "toolResultPruning", "skills"]);
      if (Object.keys(data).some(key => ["token", "apiKey", "secrets", "protectedContent", "admins", "approvers", "approvals"].includes(key))) throw Error("Unsupported local setting: infrastructure policy or credential field");
      const active: Record<string, unknown> = Object.create(null);
      const ignored: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(data)) (supported.has(key) ? active : ignored)[key] = value;
      validate(active, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      this.overlay = active;
      this.ignored = ignored;
      this.diagnostics.length = 0;
      if (Object.keys(ignored).length) {
        const message = `Ignored ${Object.keys(ignored).length} unsupported local settings field(s); preserved but NOT active. Installation-only options belong in harness.yaml.`;
        this.diagnostics.push(message);
        this.warn(message);
      }
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  snapshot(): LocalSettings { return structuredClone(this.overlay); }
  effective(): LocalSettings {
    const overrides: NonNullable<GatewayConfig["overrides"]> = {};
    for (const name of new Set([...Object.keys(this.defaults.gateways?.overrides ?? {}), ...Object.keys(this.overlay.gateways?.overrides ?? {})])) {
      overrides[name] = { ...this.defaults.gateways?.overrides?.[name], ...this.overlay.gateways?.overrides?.[name] };
    }
    return { ...this.defaults, ...this.overlay, dispatcher: dispatcherConfig({ ...this.defaults.dispatcher, ...this.overlay.dispatcher }), memory: { ...this.defaults.memory, ...this.overlay.memory }, gateways: { ...this.defaults.gateways, ...this.overlay.gateways, overrides }, review: { ...this.defaults.review, ...this.overlay.review }, skills: { ...this.defaults.skills, ...this.overlay.skills }, contextMaintenance: { ...this.defaults.contextMaintenance, ...this.overlay.contextMaintenance }, toolResultPruning: { ...this.defaults.toolResultPruning, ...this.overlay.toolResultPruning } };
  }
  source(key: SettingPath): "local overlay" | "installation/default" {
    const value = key.startsWith("review.") ? this.overlay.review?.[key.slice(7) as "model" | "thinking"] : this.overlay[key as "model" | "thinking"];
    return value === undefined ? "installation/default" : "local overlay";
  }
  setExtensionPlugin(name: string, spec?: PolicyOverride): Promise<void> {
    validatePolicyOverlay({ [name]: spec ?? {} });
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = structuredClone(this.overlay);
      updated.extensionPlugins = { ...updated.extensionPlugins };
      if (spec) updated.extensionPlugins[name] = spec; else delete updated.extensionPlugins[name];
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
    });
    this.writing = next; return next;
  }

  setPolicyPlugin(name: string, spec?: PolicyOverride): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      validatePolicyOverlay({ [name]: spec ?? {} });
      const updated = this.snapshot();
      updated.policyPlugins = { ...updated.policyPlugins };
      if (spec) updated.policyPlugins[name] = spec; else delete updated.policyPlugins[name];
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
    });
    this.writing = next;
    return next;
  }
  setGatewayPlugin(name: string, spec?: GatewayOverride): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      validateGatewayOverlay({ [name]: spec ?? {} });
      const updated = this.snapshot();
      updated.gatewayPlugins = { ...updated.gatewayPlugins };
      if (spec) updated.gatewayPlugins[name] = spec; else delete updated.gatewayPlugins[name];
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
    });
    this.writing = next;
    return next;
  }
  setMemory(value: Partial<MemoryConfig>): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = this.snapshot();
      updated.memory = { ...updated.memory, ...value };
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
    });
    this.writing = next;
    return next;
  }
  setGateways(value: GatewayConfig): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      validateGatewayConfig(value);
      const updated = this.snapshot();
      const overrides = { ...updated.gateways?.overrides };
      for (const [name, fields] of Object.entries(value.overrides ?? {})) {
        overrides[name] = { ...overrides[name], ...fields };
      }
      updated.gateways = { ...updated.gateways, ...value,
        ...(updated.gateways?.overrides || value.overrides ? { overrides } : {}),
      };
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
    });
    this.writing = next;
    return next;
  }
  setContext(value: Partial<ContextPolicy>): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = this.snapshot();
      updated.contextMaintenance = { ...updated.contextMaintenance, ...value };
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      contextPolicy({ ...this.defaults.contextMaintenance, ...updated.contextMaintenance });
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
    });
    this.writing = next;
    return next;
  }
  set(key: SettingPath, value?: string): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      if (!Object.hasOwn(keys, key)) throw new Error("Unsupported local setting");
      if (value !== undefined) validateModelSetting(keys[key], value);
      const updated = this.snapshot();
      if (key.startsWith("review.")) {
        updated.review ??= {};
        const field = key.slice(7) as "model" | "thinking";
        if (value === undefined) delete updated.review[field]; else updated.review[field] = value;
        if (!Object.keys(updated.review).length) delete updated.review;
      } else {
        const field = key as "model" | "thinking";
        if (value === undefined) delete updated[field]; else updated[field] = value;
      }
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify({ ...this.ignored, ...updated }));
      this.overlay = updated;
      if (key === "model" || key === "thinking") this.revision++;
    });
    this.writing = next;
    return next;
  }
}
