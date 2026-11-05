import { createHash } from "node:crypto";

/** Display only: never accepts prompt prose or changes routing/authority. */
export function taskContextLabel(id: string, tags?: readonly string[], known = tags !== undefined): string {
  const ref = /^[a-f0-9-]{36}(?![\s\S])/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 16);
  const safe = [...new Set((tags ?? []).filter(tag => /^[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*(?![\s\S])/.test(tag) && tag.length <= 64))].sort().slice(0, 8);
  return `task ${ref} · ${safe.length ? safe.map(tag => `#${tag}`).join(" ") : known ? "untagged" : "context unknown"}`;
}

/** Observed runtime selection, separate from per-message provider usage. */
export interface ExecutionMetadata { model?: string; thinking?: string }
/** Deliberately plain display identifiers: no control codes, markup or unbounded payloads. */
export function executionMetadata(value: ExecutionMetadata): ExecutionMetadata {
  const clean = (text: unknown) => typeof text === "string" ? text.replace(/[^a-zA-Z0-9._/:+-]/g, "").slice(0, 160) || undefined : undefined;
  return { model: clean(value.model), thinking: clean(value.thinking) };
}
export function activityExecutionLabel(value?: ExecutionMetadata, state?: "pending" | "observed" | "unavailable"): string {
  if (state === "pending") return "preparing model selection";
  const observed = executionMetadata(value ?? {});
  return `model ${observed.model ?? "unavailable"} · reasoning ${observed.thinking ?? "unavailable"}`;
}

export function executionLabel(value?: ExecutionMetadata): string {
  const observed = executionMetadata(value ?? {});
  return `model ${observed.model ?? "unknown/pending"} · reasoning ${observed.thinking ?? "unknown/pending"}`;
}
