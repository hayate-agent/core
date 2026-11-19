import { calculateContextTokens, estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";

/** Run snapshots are agent-owned ephemeral instructions, not operator messages or
 * task evidence. Persist every snapshot in the native session for audit/recovery,
 * but expose only the latest snapshot to a provider. Rebuilding at a NEW host run
 * can change the wire prefix; keeping every obsolete snapshot to preserve a cache
 * prefix grows the working context without bound. Within a run this is stable.
 * Never identify snapshots by prose: quoted/model/operator text is not ours. */
/** Agent-owned per-run message kinds. Handover, operator and tool evidence are never listed. */
const AGENT_RUN_KINDS = ["harness-run-context", "harness-skill-reference"] as const;

/** Append-only projection edits make retirement visible to native compaction,
 * pressure accounting and reopen, not just ordinary provider requests. Originals
 * remain addressable in the session archive. Call only at idle run boundaries. */
export function retireRunContexts(session: AgentSession, keepLatest: boolean): boolean {
  const manager = session.sessionManager;
  const entries = manager.buildSessionProjection().entries;
  let retired = false;
  // Skill references are per-run, host-authored and re-derived from the current
  // request; stacking them re-sends identical catalog text on every run.
  for (const kind of AGENT_RUN_KINDS) {
    const snapshots = entries.filter(entry =>
      entry.sourceEntry.type === "custom_message" && entry.sourceEntry.customType === kind &&
      entry.messages.some(message => message.role === "custom" && message.customType === kind));
    const obsolete = keepLatest ? snapshots.slice(0, -1) : snapshots;
    for (const entry of obsolete) manager.appendContextEdit(entry.sourceEntry.id, null);
    retired ||= obsolete.length > 0;
  }
  if (retired) session.refreshContext();
  return retired;
}

/** The SDK invalidates measured usage after ANY context edit. Our omissions
 * only shrink context, so the last pre-edit measurement is still a conservative
 * floor (not fresh provider usage). Reconstruct it from the canonical branch so
 * restart/reload needs no synthetic assistant, patched counter or cached state.
 * Never carry this floor across compaction or an unrelated context replacement. */
export function runContextPressure(session: AgentSession): { tokens: number; debt: number } | undefined {
  const usage = session.getContextUsage();
  if (typeof usage?.tokens !== "number" || !Number.isFinite(usage.tokens)) return;
  const branch = session.sessionManager.getBranch();
  const projection = session.sessionManager.buildSessionProjection();
  const lastCompaction = branch.findLastIndex(entry => entry.type === "compaction");
  for (let i = projection.entries.length - 1; i >= 0; i--) {
    const entry = projection.entries[i]!;
    const assistant = entry.messages.find(message => message.role === "assistant" &&
      !["aborted", "error"].includes(message.stopReason) && calculateContextTokens(message.usage) > 0);
    if (!assistant || assistant.role !== "assistant") continue;
    const sourceIndex = branch.findIndex(item => item.id === entry.sourceEntry.id);
    if (sourceIndex <= lastCompaction) return;
    const edits = branch.slice(sourceIndex + 1).filter(item => item.type === "context_edit");
    if (!edits.length || edits.some(edit => {
      const target = session.sessionManager.getEntry(edit.targetId);
      return edit.replacement !== null || target?.type !== "custom_message" || !(AGENT_RUN_KINDS as readonly string[]).includes(target.customType);
    })) return;
    const trailing = projection.entries.slice(i + 1).flatMap(item => item.messages)
      .reduce((tokens, message) => tokens + estimateTokens(message), 0);
    const tokens = Math.max(usage.tokens, calculateContextTokens(assistant.usage) + trailing);
    return { tokens, debt: Math.max(0, tokens - usage.tokens) };
  }
}

export function currentRunContext<T extends { role: string; customType?: string }>(messages: T[]): T[] {
  const latest = new Map<string, number>();
  messages.forEach((message, i) => {
    if (message.role === "custom" && (AGENT_RUN_KINDS as readonly string[]).includes(message.customType ?? "")) latest.set(message.customType!, i);
  });
  let changed = false;
  const selected = messages.filter((message, i) => {
    const remove = message.role === "custom" && latest.has(message.customType ?? "") && latest.get(message.customType!) !== i;
    changed ||= remove;
    return !remove;
  });
  return changed ? selected : messages;
}
