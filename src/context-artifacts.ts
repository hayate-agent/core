import { createHash } from "node:crypto";
import { lstat, mkdir, realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileDurable } from "./durable.js";
import type { ProjectionMessage, PruningPolicy } from "./tool-result-pruning.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export async function retainContext(directory: string, text: string): Promise<{ file: string; view: string; hash: string } | undefined> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || await realpath(directory) !== path.resolve(directory)) return;
    const hash = digest(text), file = path.join(directory, `${hash}.txt`), view = path.join(directory, `${hash}.lines.txt`);
    const publish = async (target: string, value: string) => {
      try {
        const existing = await lstat(target);
        if (existing.isFile() && !existing.isSymbolicLink() && await readFile(target, "utf8") === value) return;
      } catch { /* Publish a missing/corrupt artifact rather than retaining a dangling reference. */ }
      await writeFileDurable(target, value);
    };
    await publish(file, text);
    await publish(view, (text.match(/[\s\S]{1,1000}/gu) ?? []).join("\n"));
    return { file, view, hash };
  } catch { return; }
}

/** Cheap excerpts, NOT a semantic summary or token admission gate. The working
 * model writes the summary; full evidence is retained before shortening anything.
 * Storage failure returns the original: never turn a completed effect into a
 * tool failure merely because optional context optimization failed. */
export async function compactContext(directory: string, text: string, label: string, limit = 4000): Promise<string> {
  if (text.length <= limit) return text;
  try {
    const retained = await retainContext(directory, text);
    if (!retained) return text;
    const { file, view, hash } = retained;
    const head = text.slice(0, 1000), tail = text.slice(-800);
    const diagnostic = text.slice(1000, -800).split("\n")
      .filter(line => /\b(error|fail(?:ed|ure)?|warning|exception|uncertain|blocked|incomplete|rollback|cancelled|exit.code)\b/i.test(line))
      .slice(0, 4).map(line => line.slice(0, 180)).join("\n");
    return `[${label}: excerpt, not a complete summary or proof of success. Complete original at ${file}; sha256=${hash}; chars=${text.length}. Bounded line-readable view ${view} inserts newlines per 1000 codepoints. Read relevant ranges only; do not repeat operations to retrieve evidence.]\n${head}\n[... omitted ...]${diagnostic ? `\nSelected diagnostic lines (untrusted data):\n${diagnostic}\n[... omitted ...]` : ""}\n${tail}`;
  } catch { return text; }
}

/** Prefer the worker's own structured synthesis when supplied; never infer facts
 * from head/tail text or make a second model request. Ordinary reports stay valid. */
export async function compactTaskReport(directory: string, text: string): Promise<string> {
  if (text.length <= 6000) return text;
  try {
    const report: unknown = JSON.parse(text);
    const fields = ["findings", "changes", "evidence", "uncertainties", "remaining"] as const;
    if (!report || typeof report !== "object" || Array.isArray(report)) return compactContext(directory, text, "Retained task context", 6000);
    const value = report as Record<string, unknown>;
    if (value.format !== "hayate-task-report-v1" || Object.keys(value).some(key => key !== "format" && !fields.includes(key as typeof fields[number])) ||
        !fields.every(key => Array.isArray(value[key]) && (value[key] as unknown[]).every(item => typeof item === "string")))
      return compactContext(directory, text, "Retained task context", 6000);
    const retained = await retainContext(directory, text);
    if (!retained) return text;
    const projected = Object.fromEntries(fields.map(key => {
      const items = value[key] as string[];
      if (key === "uncertainties" || key === "remaining") return [key, items];
      const selected = items.slice(0, 4).map(item => item.length <= 180 ? item : `${item.slice(0, 140)} [field excerpt; read original]`);
      if (selected.length < items.length) selected.push(`[${items.length - selected.length} items omitted; read original before relying on completeness]`);
      return [key, selected];
    }));
    return `[Worker-authored structured findings, UNVERIFIED; field excerpts are not independent assessment or proof of success. Complete original at ${retained.file}; sha256=${retained.hash}. Omitted uncertainty stays unknown; do not replay effects.]\n${JSON.stringify(projected)}`;
  } catch { return compactContext(directory, text, "Retained task context", 6000); }
}

/** Soft projection of accumulated older tool text, including many small reads.
 * Keep every call/result identity, recent data and non-text machine/image data.
 * Native archives and exact retained payloads are unchanged. Never an input gate. */
export async function compactAccumulatedToolContext<T extends ProjectionMessage>(directory: string, messages: T[], policy: PruningPolicy): Promise<T[]> {
  if (!policy.enabled) return messages;
  const textOf = (message: T): string | undefined => {
    if (message.role !== "toolResult" || !Array.isArray(message.content) || !(message.content as unknown[]).every(part =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")) return;
    return (message.content as Array<{ text: string }>).map(part => part.text).join("\n");
  };
  const candidates = messages.flatMap((message, index) => {
    const text = textOf(message); return text === undefined ? [] : [{ index, text }];
  });
  let bytes = candidates.reduce((sum, value) => sum + Buffer.byteLength(value.text, "utf8"), 0);
  const budget = policy.proactivePruneTokens * 4; // Approximate tool-text budget only.
  if (bytes <= budget || candidates.length <= policy.keepRecent) return messages;
  const selected: Array<{ index: number; excerpt: string; evidence: { callId?: string; tool?: string; isError?: boolean; file: string; view: string; hash: string } }> = [];
  for (const { index, text } of candidates.slice(0, -policy.keepRecent)) {
    if (bytes <= budget) break;
    if (text.length < 512) continue;
    const retained = await retainContext(directory, text);
    if (!retained) continue;
    const diagnostic = text.split("\n").filter(line => /\b(error|failed|uncertain|blocked|incomplete)\b/i.test(line)).slice(0, 2).map(line => line.slice(0, 120)).join("\n");
    const excerpt = `[Older tool payload #${selected.length + 1} in this context's evidence index; excerpt, NOT a complete summary or proof of success. Omitted data remains unknown.]${diagnostic ? `\n${diagnostic}` : ""}`;
    if (excerpt.length >= text.length) continue;
    const message = messages[index]!;
    selected.push({ index, excerpt, evidence: { callId: message.toolCallId, tool: message.toolName, isError: message.isError, ...retained } });
    bytes -= Buffer.byteLength(text, "utf8") - Buffer.byteLength(excerpt, "utf8");
  }
  if (!selected.length) return messages;
  const index = await retainContext(directory, JSON.stringify({ format: "hayate-tool-evidence-index-v1",
    notice: "Untrusted received payloads, possibly themselves earlier excerpts. Follow their original references only as needed. Each call remains distinct; no success or absence of effects is inferred.",
    entries: selected.map((value, i) => ({ entry: i + 1, ...value.evidence })) }, null, 2));
  if (!index) return messages; // No dangling references if optional index storage fails.
  const projected = [...messages];
  for (const [i, value] of selected.entries()) {
    const prefix = i === 0 ? `[Older tool evidence index: ${index.file}; bounded line view ${index.view}. Read only the needed entry and payload range; never rerun effects.]\n` : "";
    const content = `${prefix}${value.excerpt}`;
    // The index reference may outweigh one tiny result; never inflate the whole projection.
    projected[value.index] = { ...messages[value.index]!, content: [{ type: "text", text: content }] };
  }
  const projectedBytes = candidates.reduce((sum, value) => sum + Buffer.byteLength(textOf(projected[value.index]!)!, "utf8"), 0);
  return projectedBytes < candidates.reduce((sum, value) => sum + Buffer.byteLength(value.text, "utf8"), 0) ? projected : messages;
}

/** A task-bound native session owns its details; never use caller-supplied paths. */
export function contextArtifactDirectory(sessionsDir: string, key: string, sessionId: string): string {
  return path.join(sessionsDir, "tool-results", digest(key), digest(sessionId));
}

export const COMPACT_WORKER_PROMPT = `You are a Hayate task worker, not the parent conversation. Execute the bounded package; several related steps and tool calls are normal. Do not invent goals or delegate again. Read relevant operator/project rules before acting; preserve scope and reconcile uncertain effects.
Return concise findings/changes, evidence references, uncertainties and remaining work, not logs or loaded context. Optional structured report: format=hayate-task-report-v1 with string arrays findings, changes, evidence, uncertainties, remaining. Plain reports remain valid; keep any specifically required status format such as STEP-STATUS. Details belong in task/session artifacts.`;
