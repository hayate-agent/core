import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { writeFileDurable } from "./durable.js";
import { contextPolicy, type ContextPolicy } from "./context-maintenance.js";
import { validateModelSetting, type ModelSetting } from "./model-settings.js";

/** Explicit runtime-writable allowlist; security policy and secrets are deliberately excluded. */
export interface LocalSettings {
  model?: string;
  thinking?: string;
  review?: { model?: string; thinking?: string };
  contextMaintenance?: Partial<ContextPolicy>;
}
export type SettingPath = "model" | "thinking" | "review.model" | "review.thinking";
const keys: Record<SettingPath, ModelSetting> = { model: "model", thinking: "thinking", "review.model": "reviewModel", "review.thinking": "reviewThinking" };
function validate(value: unknown, defaults: Partial<ContextPolicy> = {}): asserts value is LocalSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local settings overlay");
  const data = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(data)) {
    if (key === "contextMaintenance") {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid context policy overlay");
      const allowed = ["enabled", "checkEveryTurns", "assessPercent", "compactPercent", "cooldownTurns", "autoHandover"];
      if (Object.keys(item).some((k) => !allowed.includes(k))) throw new Error("Unsupported context setting");
      contextPolicy({ ...defaults, ...item });
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
  private writing: Promise<unknown> = Promise.resolve();
  revision = 0;
  constructor(readonly file: string, private readonly defaults: LocalSettings) {}
  async load(): Promise<void> {
    try {
      const data = parse(await readFile(this.file, "utf8"));
      validate(data, this.defaults.contextMaintenance);
      this.overlay = data;
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  snapshot(): LocalSettings { return structuredClone(this.overlay); }
  effective(): LocalSettings {
    return { ...this.defaults, ...this.overlay, review: { ...this.defaults.review, ...this.overlay.review }, contextMaintenance: { ...this.defaults.contextMaintenance, ...this.overlay.contextMaintenance } };
  }
  source(key: SettingPath): "local overlay" | "installation/default" {
    const value = key.startsWith("review.") ? this.overlay.review?.[key.slice(7) as "model" | "thinking"] : this.overlay[key as "model" | "thinking"];
    return value === undefined ? "installation/default" : "local overlay";
  }
  setContext(value: Partial<ContextPolicy>): Promise<void> {
    const next = this.writing.catch(() => {}).then(async () => {
      const updated = this.snapshot();
      updated.contextMaintenance = { ...updated.contextMaintenance, ...value };
      validate(updated, this.defaults.contextMaintenance);
      contextPolicy({ ...this.defaults.contextMaintenance, ...updated.contextMaintenance });
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify(updated));
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
      validate(updated, this.defaults.contextMaintenance);
      await mkdir(path.dirname(this.file), { recursive: true });
      await writeFileDurable(this.file, stringify(updated));
      this.overlay = updated;
      if (key === "model" || key === "thinking") this.revision++;
    });
    this.writing = next;
    return next;
  }
}
