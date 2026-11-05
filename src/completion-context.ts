import { createHash } from "node:crypto";
import type { ArchiveEntry } from "./session-archive.js";
import { projectObservation } from "./completion-budget.js";

export interface CompletionIngress {
  id: string; text: string; state: string; receivedAt?: number; expiresAt?: number;
  termination?: string; provenance: "host-task-anchor" | "legacy-task-original";
}
export interface CompletionObservation extends ArchiveEntry { digest: string; totalChars?: number }
export interface ResolvedCompletionContext {
  taskId?: string;
  /** Host captured ingress. Historical records explain scope; never grant executable authority. */
  ingress: CompletionIngress[];
  /** Untrusted evidence, including handover, summaries and tool observations. */
  observations: CompletionObservation[];
  incomplete: boolean;
  digest: string;
  omittedObservations?: number;
  transcript?: { current: "available" | "empty" | "missing" | "failed"; archive: "available" | "empty" | "missing" | "failed" };
}

/** Mechanical bounded packaging only. Newest current evidence takes priority.
 * Never follow transcript paths or promote archive roles into trusted ingress. */
export function resolveCompletionContext(taskId: string | undefined, ingress: CompletionIngress[],
  retained: ArchiveEntry[], current: ArchiveEntry[], unavailable = false): ResolvedCompletionContext {
  let incomplete = unavailable;
  let budget = 64000;
  const selected = new Map<string, CompletionIngress>();
  const take = (entry: CompletionIngress) => {
    if (selected.has(entry.id)) return;
    if (entry.text.length > budget || selected.size >= 128) { incomplete = true; return; }
    selected.set(entry.id, structuredClone(entry)); budget -= entry.text.length;
  };
  // Keep the exact selected task, earliest retained mandate and latest amendments.
  const target = ingress.find(entry => entry.id === taskId);
  if (target) take(target);
  if (ingress[0]) take(ingress[0]);
  for (const entry of [...ingress].reverse()) take(entry);
  const records = ingress.filter(entry => selected.has(entry.id)).map(entry => selected.get(entry.id)!);
  budget = 32000;
  const evidence: CompletionObservation[] = [];
  const seen = new Set<string>();
  // Current branch takes priority over bounded durable evidence from prior turns.
  for (const entry of [...retained, ...current].reverse()) {
    if (!entry.text || /^(host-attention|recovery-notice)$/.test(entry.role)) continue;
    const digest = createHash("sha256").update(JSON.stringify(entry)).digest("hex");
    if (seen.has(digest)) continue;
    seen.add(digest);
    if (budget <= 0 || evidence.length >= 48) { incomplete = true; continue; }
    const { text, truncated, totalChars } = projectObservation(entry.text, entry.role, Math.min(8000, budget));
    if (truncated || entry.truncated) incomplete = true;
    evidence.push({ id: entry.id, role: entry.role, text, digest, totalChars, source: entry.source ?? (current.includes(entry) ? "current" : "archive"), ...(truncated || entry.truncated ? { truncated: true } : {}) });
    budget -= text.length;
  }
  evidence.reverse();
  const data = { taskId, ingress: records, observations: evidence, incomplete };
  return { ...data, digest: createHash("sha256").update(JSON.stringify(data)).digest("hex") };
}
