import { validatePolicyOverlay, type PolicyOverlay, type PolicyOverride } from "./policy-modules.js";
import { dispatcherConfig, type DispatcherConfig } from "./dispatcher-config.js";
import { validateGatewayOverlay, type GatewayOverlay, type GatewayOverride } from "./gateway-provider.js";
import { memoryConfig, type MemoryConfig } from "./memory.js";
import { validateGatewayConfig, type GatewayConfig } from "./gateway-settings.js";
import { mkdir, readFile, readdir, lstat, open } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "yaml";
import { writeFileDurable } from "./durable.js";
import { pruningPolicy, type PruningPolicy } from "./tool-result-pruning.js";
import { contextPolicy, type ContextPolicy } from "./context-maintenance.js";
import { validateModelRoles, type ModelRoles } from "./model-roles.js";
import { validateModelSetting, type ModelSetting } from "./model-settings.js";

/** Explicit runtime-writable allowlist; security policy and secrets are deliberately excluded. */
export interface LocalSettings {
  modelRoles?: ModelRoles;
  dispatcher?: Partial<DispatcherConfig>;
  reasoningEffortNoneModels?: string[];
  gateways?: GatewayConfig;
  gatewayPlugins?: GatewayOverlay;
  policyPlugins?: PolicyOverlay;
  extensionPlugins?: PolicyOverlay;
  memory?: Partial<MemoryConfig>;
  /** null disables; absence restores the immutable installation selection. */
  completionStrategy?: string | null;
  nightlyStrategy?: string | null;
  contextStrategy?: string | null;
  compactionStrategy?: string;
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
    if (key === "modelRoles") {
      validateModelRoles(item);
    } else if (key === "reasoningEffortNoneModels") {
      validateReasoningEffortNoneModels(item);
    } else if (key === "compactionStrategy") {
      if (typeof item !== "string" || !item.trim()) throw Error("Invalid compaction strategy selection");
    } else if (key === "completionStrategy" || key === "nightlyStrategy" || key === "contextStrategy") {
      if (item !== null && (typeof item !== "string" || !item.trim())) throw Error(`Invalid ${key === "nightlyStrategy" ? "nightly" : key === "contextStrategy" ? "context" : "completion"} strategy selection`);
    } else if (key === "dispatcher") {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["enabled", "strategy", "concurrentRequests", "capacity", "retentionDays", "rules"].includes(key))) throw Error("Invalid dispatcher overlay");
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
      const allowed = ["compactionOwner", "enabled", "checkEveryTurns", "assessPercent", "compactPercent", "cooldownTurns", "autoHandover"];
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

export function validateReasoningEffortNoneModels(value: unknown): asserts value is string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(ref => typeof ref !== "string" || !ref || ref.length > 200 || !/^[^/\s]+\/[^\s]+$/.test(ref))) {
    throw Error("reasoningEffortNoneModels must be an array of 'provider/model' refs");
  }
}

/** Category-specific layering: arrays replace; only documented maps merge. */
function mergeSettings(base: LocalSettings, layer: LocalSettings): LocalSettings {
  const result = { ...base, ...layer };
  for (const key of ["dispatcher", "memory", "review", "skills", "contextMaintenance", "toolResultPruning"] as const) {
    if (base[key] !== undefined || layer[key] !== undefined) (result as Record<string, unknown>)[key] = { ...base[key], ...layer[key] };
  }
  for (const key of ["gatewayPlugins", "policyPlugins", "extensionPlugins"] as const) {
    if (base[key] === undefined && layer[key] === undefined) continue;
    const entries: Record<string, GatewayOverride> = { ...base[key] };
    for (const [name, fields] of Object.entries(layer[key] ?? {})) entries[name] = { ...entries[name], ...fields };
    result[key] = entries;
  }
  if (base.gateways !== undefined || layer.gateways !== undefined) {
    const overrides = { ...base.gateways?.overrides };
    for (const [name, fields] of Object.entries(layer.gateways?.overrides ?? {})) overrides[name] = { ...overrides[name], ...fields };
    result.gateways = { ...base.gateways, ...layer.gateways, overrides };
  }
  return structuredClone(result);
}

/** One owner per Harness home; atomic serialized updates, published only after durable save. */
export class SettingsService {
  private overlay: LocalSettings = {};
  readonly diagnostics: string[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  revision = 0;
  constructor(readonly file: string, private readonly defaults: LocalSettings, private readonly warn: (message: string) => void = () => {}) {}
  private diagnose(message: string): void {
    // Never include values/parser excerpts: overlays can contain misplaced secrets.
    if (this.diagnostics.length >= 20) return;
    const bounded = message.slice(0, 240);
    this.diagnostics.push(bounded);
    this.warn(bounded);
  }
  private async readLegacyOverlay(live: boolean): Promise<void> {
    this.diagnostics.length = 0;
    let raw: unknown;
    try {
      raw = parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") raw = {};
      else { this.diagnose("Ignored unreadable or malformed local settings overlay; retaining previous settings (installation defaults at startup)."); return; }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      this.diagnose("Ignored non-object local settings overlay; retaining previous settings (installation defaults at startup).");
      return;
    }
    const previous = this.snapshot() as Record<string, any>;
    const result: Record<string, any> = Object.assign(Object.create(null), live ? structuredClone(previous) : {});
    const check = (value: unknown) => validate(value, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
    const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
    const livePath = (parts: string[]) => parts[0] === "modelRoles" || parts[0] === "reasoningEffortNoneModels" || ["model", "thinking", "review.model", "review.thinking", "dispatcher.rules"].includes(parts.join("."));
    if (live) {
      try { check(raw); } catch { this.diagnose("Ignored invalid local settings overlay; retaining previous settings."); return; }
    }
    const accept = (value: any, old: any, parts: string[], wrap: (v: any) => unknown): any => {
      const label = parts.map(p => p.replace(/[^a-zA-Z0-9_-]/g, "?").slice(0, 48)).join(".");
      if (live && !livePath(parts) && !["dispatcher", "review"].includes(parts.join("."))) {
        if (!isDeepStrictEqual(value, old)) this.diagnose(`Ignored ${label}: not live-editable; restart required.`);
        return old;
      }
      // A routing array is a coherent safety unit: removing a bad earlier rule
      // could route its traffic to a later fallback. Never filter its constraints.
      if (parts[0] === "reasoningEffortNoneModels" && Array.isArray(value) && value.length <= 20) {
        value = value.filter(entry => {
          try { validateReasoningEffortNoneModels([entry]); return true; }
          catch { this.diagnose(`Ignored ${label} entry: invalid provider/model reference.`); return false; }
        });
        if (!value.length && (raw as Record<string, any>).reasoningEffortNoneModels.length) return old;
      }
      try {
        if (!(live && ["dispatcher", "review"].includes(parts.join(".")))) { check(wrap(value)); return structuredClone(value); }
      } catch { /* salvage independent fields below */ }
      if (object(value) && ((parts.length === 1 && ["dispatcher", "review", "skills", "contextMaintenance", "toolResultPruning", "memory", "gateways", "gatewayPlugins", "policyPlugins", "extensionPlugins"].includes(parts[0])) ||
          (parts[0] === "gateways" && parts[1] === "overrides" && parts.length <= 3))) {
        const merged: Record<string, any> = Object.create(null);
        // Missing fields restore inheritance, except non-live fields on reload.
        for (const key of new Set([...Object.keys(old ?? {}), ...Object.keys(value)])) {
          if (!Object.hasOwn(value, key) && live && !livePath([...parts, key])) merged[key] = old[key];
        }
        // Concurrency consent and enablement are one safety unit.
        if (parts.join(".") === "dispatcher" && !live && Object.hasOwn(value, "enabled") && Object.hasOwn(value, "concurrentRequests")) {
          const pair = { enabled: value.enabled, concurrentRequests: value.concurrentRequests };
          try { check(wrap(pair)); Object.assign(merged, pair); } catch { /* individually validate below */ }
        }
        if (parts.join(".") === "contextMaintenance" && Object.hasOwn(value, "assessPercent") && Object.hasOwn(value, "compactPercent")) {
          const pair = { assessPercent: value.assessPercent, compactPercent: value.compactPercent };
          try { check(wrap(pair)); Object.assign(merged, pair); } catch { /* individually validate below */ }
        }
        if (parts.join(".") === "toolResultPruning" && Object.hasOwn(value, "minResultChars") && Object.hasOwn(value, "maxResultChars")) {
          const pair = { minResultChars: value.minResultChars, maxResultChars: value.maxResultChars };
          try { check(wrap(pair)); Object.assign(merged, pair); } catch { /* individually validate below */ }
        }
        for (const [key, field] of Object.entries(value).sort(([a], [b]) => Number(a === "enabled") - Number(b === "enabled"))) {
          if (Object.hasOwn(merged, key) && isDeepStrictEqual(merged[key], field)) continue;
          const selected = accept(field, old?.[key], [...parts, key], v => wrap({ ...merged, [key]: v }));
          if (selected !== undefined) merged[key] = selected;
        }
        try { check(wrap(merged)); return merged; } catch { /* preserve safe previous unit */ }
      }
      this.diagnose(`Ignored ${label}: invalid or unsupported setting${parts.join(".") === "dispatcher.rules" ? "; whole routing array retained for safety" : ""}.`);
      return old;
    };
    for (const key of new Set([...Object.keys(previous), ...Object.keys(raw)])) {
      if (!Object.hasOwn(raw, key)) {
        if (!live || livePath([key])) delete result[key];
        else if (key === "dispatcher" && result.dispatcher) delete result.dispatcher.rules;
        else if (key === "review") delete result.review;
        else this.diagnose(`Ignored removal of ${key.slice(0, 48)}: not live-editable; restart required.`);
        continue;
      }
      const value = accept((raw as Record<string, unknown>)[key], previous[key], [key], v => ({ ...result, [key]: v }));
      if (value !== undefined) result[key] = value;
    }
    check(result);
    if (["model", "thinking"].some(key => !isDeepStrictEqual(previous[key], result[key]))) this.revision++;
    this.overlay = result;
  }
  /** Desired startup-bound changes are separate from the actually active snapshot. */
  restartPending: string[] = [];
  private layered = false;
  private check(value: unknown): asserts value is LocalSettings {
    validate(value, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
  }
  private async readSettingsFile(file: string, optional = false): Promise<LocalSettings> {
    let handle;
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      if (!(await handle.stat()).isFile()) throw Error("not a regular file");
      const value: unknown = parse(await handle.readFile("utf8")) ?? {};
      this.check(value);
      return value;
    } catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
      // Do not expose parser excerpts or misplaced secrets.
      throw Error(`Invalid or unreadable settings file: ${file}`);
    } finally { await handle?.close(); }
  }
  private async dropins(): Promise<string[]> {
    const directory = path.join(path.dirname(this.file), "settings.d");
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error("not a regular directory");
      return (await readdir(directory)).filter(name => /\.ya?ml$/.test(name)).sort().map(name => path.join(directory, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw Error(`Invalid or unreadable settings directory: ${directory}`);
    }
  }
  private async candidate(local?: LocalSettings): Promise<LocalSettings> {
    const files = await this.dropins();
    let result = local ?? await this.readSettingsFile(this.file, true);
    for (const file of files) {
      result = mergeSettings(result, await this.readSettingsFile(file));
      try { this.check(mergeSettings(this.defaults, result)); }
      catch { throw Error(`Invalid combined settings at: ${file}`); }
    }
    try { this.check(mergeSettings(this.defaults, result)); }
    catch { throw Error(`Invalid combined settings at: ${this.file}`); }
    return result;
  }
  private desiredOverlay: LocalSettings = {};
  private pluginReload?: () => Promise<void>;
  onPluginReload(reload: () => Promise<void>): void { this.pluginReload = reload; }
  desired(): LocalSettings { return mergeSettings(this.defaults, this.desiredOverlay); }
  /** Managers publish only after a successful idle-boundary activation. */
  appliedPlugin(key: "gatewayPlugins" | "policyPlugins" | "extensionPlugins", id: string, spec: PolicyOverride | undefined): void {
    const entries: Record<string, PolicyOverride> = { ...this.overlay[key] };
    if (spec === undefined) delete entries[id]; else entries[id] = structuredClone(spec);
    this.overlay[key] = entries;
    if (isDeepStrictEqual(this.effective()[key] ?? {}, this.desired()[key] ?? {})) {
      this.restartPending = this.restartPending.filter(pending => pending !== key);
    }
  }
  private activate(candidate: LocalSettings, live: boolean): void {
    this.desiredOverlay = structuredClone(candidate);
    this.restartPending = [];
    if (!live) { this.overlay = candidate; return; }
    const active = structuredClone(this.overlay);
    const before = mergeSettings(this.defaults, active);
    const after = mergeSettings(this.defaults, candidate);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)]) as Set<keyof LocalSettings>) {
      if (["modelRoles", "model", "thinking", "review", "reasoningEffortNoneModels"].includes(key)) continue;
      if (key === "dispatcher") {
        const { rules: _a, ...a } = before.dispatcher ?? {};
        const { rules: _b, ...b } = after.dispatcher ?? {};
        if (!isDeepStrictEqual(a, b)) this.restartPending.push(key);
      } else if (!isDeepStrictEqual(before[key], after[key])) this.restartPending.push(key);
    }
    if (candidate.modelRoles === undefined) delete active.modelRoles;
    else active.modelRoles = structuredClone(candidate.modelRoles);
    if (candidate.reasoningEffortNoneModels === undefined) delete active.reasoningEffortNoneModels;
    else active.reasoningEffortNoneModels = candidate.reasoningEffortNoneModels;
    if (active.dispatcher || candidate.dispatcher?.rules !== undefined) {
      active.dispatcher = { ...active.dispatcher };
      if (candidate.dispatcher?.rules === undefined) delete active.dispatcher.rules;
      else active.dispatcher.rules = candidate.dispatcher.rules;
    }
    for (const key of ["model", "thinking", "review"] as const) {
      if (!isDeepStrictEqual(active[key], candidate[key])) this.revision++;
      if (candidate[key] === undefined) delete active[key];
      else Object.assign(active, { [key]: structuredClone(candidate[key]) });
    }
    this.overlay = active;
    for (const key of this.restartPending) this.diagnose(`Pending ${key}: ${key.endsWith("Plugins") ? "lifecycle activation pending" : "restart required"}; active value unchanged.`);
  }
  private async readOverlay(live: boolean): Promise<void> {
    this.diagnostics.length = 0;
    try {
      // Preserve historical startup salvage for installations without settings.d.
      // Once the directory exists, every layer is a strict transaction.
      const directory = path.join(path.dirname(this.file), "settings.d");
      const hasDirectory = await lstat(directory).then(() => true, error => {
        if (error.code === "ENOENT") return false;
        throw error;
      });
      this.layered ||= hasDirectory;
      if (!this.layered) {
        await this.readLegacyOverlay(live);
        if (!live) this.desiredOverlay = this.snapshot();
        else {
          try {
            const candidate = await this.candidate();
            const desired = this.snapshot();
            for (const key of ["gatewayPlugins", "policyPlugins", "extensionPlugins"] as const) {
              if (candidate[key] === undefined) delete desired[key]; else desired[key] = candidate[key];
            }
            this.activate(desired, true);
          } catch { /* Legacy tolerance retains last good plugin snapshot too. */ }
        }
      } else this.activate(await this.candidate(), live);
    } catch (error) {
      this.diagnose((error as Error).message);
      if (live) throw error;
    }
  }
  private async localForMutation(): Promise<LocalSettings> {
    const directory = path.join(path.dirname(this.file), "settings.d");
    this.layered ||= await lstat(directory).then(() => true, error => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
    const local = this.layered ? await this.readSettingsFile(this.file, true) : structuredClone(this.desiredOverlay);
    return local;
  }
  private async saveLocal(updated: LocalSettings, target: string[], additionalTargets: string[][] = []): Promise<void> {
    this.check(updated);
    const candidate = await this.candidate(updated);
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFileDurable(this.file, stringify(updated));
    if (!this.layered && !target[0]?.endsWith("Plugins")) {
      const active = this.snapshot();
      this.activate(candidate, false);
      for (const key of ["gatewayPlugins", "policyPlugins", "extensionPlugins"] as const) {
        if (active[key] === undefined) delete this.overlay[key]; else this.overlay[key] = active[key];
        if (!isDeepStrictEqual(this.effective()[key] ?? {}, this.desired()[key] ?? {})) this.restartPending.push(key);
      }
      return;
    }
    // Publish only the explicitly requested field/entry, even for identical disk writes.
    const publish = (active: Record<string, unknown>, desired: Record<string, unknown>, segments: string[]): void => {
      const [key, ...rest] = segments;
      if (rest.length) {
        active[key] = { ...(active[key] as object | undefined) };
        publish(active[key] as Record<string, unknown>, (desired[key] ?? {}) as Record<string, unknown>, rest);
      } else if (desired[key] === undefined) delete active[key];
      else active[key] = structuredClone(desired[key]);
    };
    for (const segments of [target, ...additionalTargets].filter(segments => segments.length && !segments[0].endsWith("Plugins"))) publish(this.overlay as Record<string, unknown>, candidate as Record<string, unknown>, segments);
    this.activate(candidate, true);
  }
  async load(): Promise<void> {
    await this.readOverlay(false);
  }
  snapshot(): LocalSettings { return structuredClone(this.overlay); }
  /** Model defaults, routing and request compatibility change at a live boundary. */
  reload(): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      await this.readOverlay(true);
      await this.pluginReload?.();
    });
    this.writing = next;
    return next;
  }
  effective(): LocalSettings {
    const result = mergeSettings(this.defaults, this.overlay);
    result.dispatcher = dispatcherConfig(result.dispatcher);
    return result;
  }
  source(key: SettingPath): string {
    const value = key.startsWith("review.") ? this.overlay.review?.[key.slice(7) as "model" | "thinking"] : this.overlay[key as "model" | "thinking"];
    return value === undefined ? "installation/default" : "local overlay";
  }
  setExtensionPlugin(name: string, spec?: PolicyOverride): Promise<void> {
    validatePolicyOverlay({ [name]: spec ?? {} });
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      updated.extensionPlugins = { ...updated.extensionPlugins };
      if (spec) updated.extensionPlugins[name] = spec; else delete updated.extensionPlugins[name];
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await this.saveLocal(updated, ["extensionPlugins", name]);
    });
    this.writing = next; return next;
  }

  setPolicyPlugin(name: string, spec?: PolicyOverride): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      validatePolicyOverlay({ [name]: spec ?? {} });
      const updated = await this.localForMutation();
      updated.policyPlugins = { ...updated.policyPlugins };
      if (spec) updated.policyPlugins[name] = spec; else delete updated.policyPlugins[name];
      await this.saveLocal(updated, ["policyPlugins", name]);
    });
    this.writing = next;
    return next;
  }
  setGatewayPlugin(name: string, spec?: GatewayOverride): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      validateGatewayOverlay({ [name]: spec ?? {} });
      const updated = await this.localForMutation();
      updated.gatewayPlugins = { ...updated.gatewayPlugins };
      if (spec) updated.gatewayPlugins[name] = spec; else delete updated.gatewayPlugins[name];
      await this.saveLocal(updated, ["gatewayPlugins", name]);
    });
    this.writing = next;
    return next;
  }
  setModelRoles(value: ModelRoles | undefined): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      if (value === undefined) delete updated.modelRoles; else updated.modelRoles = structuredClone(value);
      await this.saveLocal(updated, ["modelRoles"]);
    });
    this.writing = next;
    return next;
  }
  setCompactionStrategy(value: string | undefined): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      if (value === undefined) delete updated.compactionStrategy; else updated.compactionStrategy = value;
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await this.saveLocal(updated, ["compactionStrategy"]);
    });
    this.writing = next;
    return next;
  }
  setContextStrategy(value: string | null | undefined): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      if (value === undefined) delete updated.contextStrategy; else updated.contextStrategy = value;
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await this.saveLocal(updated, ["contextStrategy"]);
    });
    this.writing = next;
    return next;
  }
  setNightlyStrategy(value: string | null | undefined): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      if (value === undefined) delete updated.nightlyStrategy; else updated.nightlyStrategy = value;
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await this.saveLocal(updated, ["nightlyStrategy"]);
    });
    this.writing = next;
    return next;
  }
  setCompletionStrategy(value: string | null | undefined): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      if (value === undefined) delete updated.completionStrategy; else updated.completionStrategy = value;
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      await this.saveLocal(updated, ["completionStrategy"]);
    });
    this.writing = next;
    return next;
  }
  setMemory(value: Partial<MemoryConfig>): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      updated.memory = { ...updated.memory, ...value };
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      const targets = Object.keys(value).map(key => ["memory", key]);
      await this.saveLocal(updated, targets[0] ?? [], targets.slice(1));
    });
    this.writing = next;
    return next;
  }
  setGateways(value: GatewayConfig): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      validateGatewayConfig(value);
      const updated = await this.localForMutation();
      const overrides = { ...updated.gateways?.overrides };
      for (const [name, fields] of Object.entries(value.overrides ?? {})) {
        overrides[name] = { ...overrides[name], ...fields };
      }
      updated.gateways = { ...updated.gateways, ...value,
        ...(updated.gateways?.overrides || value.overrides ? { overrides } : {}),
      };
      const targets = Object.keys(value).flatMap(key => key === "overrides"
        ? Object.entries(value.overrides ?? {}).flatMap(([name, fields]) => Object.keys(fields).map(field => ["gateways", "overrides", name, field]))
        : [["gateways", key]]);
      await this.saveLocal(updated, targets[0] ?? [], targets.slice(1));
    });
    this.writing = next;
    return next;
  }
  setContext(value: Partial<ContextPolicy>): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = await this.localForMutation();
      updated.contextMaintenance = { ...updated.contextMaintenance, ...value };
      validate(updated, this.defaults.contextMaintenance, this.defaults.toolResultPruning, this.defaults.dispatcher);
      contextPolicy({ ...this.defaults.contextMaintenance, ...updated.contextMaintenance });
      const targets = Object.keys(value).map(key => ["contextMaintenance", key]);
      await this.saveLocal(updated, targets[0] ?? [], targets.slice(1));
    });
    this.writing = next;
    return next;
  }
  set(key: SettingPath, value?: string): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      if (!Object.hasOwn(keys, key)) throw new Error("Unsupported local setting");
      if (value !== undefined) validateModelSetting(keys[key], value);
      const updated = await this.localForMutation();
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
      await this.saveLocal(updated, key.split("."));
      if (key === "model" || key === "thinking") this.revision++;
    });
    this.writing = next;
    return next;
  }
}
