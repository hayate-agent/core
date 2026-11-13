import type { ArchiveEntry } from "./session-archive.js";

/** Wire bytes, not raw text length: JSON quoting and Unicode also consume context. */
export const RECOVERY_EVIDENCE_BYTES = 48 * 1024;
export const HANDOVER_SEED_BYTES = 64 * 1024;
const clip = (text: string, max = 3072): string => text.length <= max ? text
  : `${text.slice(0, Math.floor(max / 2))}\n[truncated recovery evidence; inspect original before any uncertain effect]\n${text.slice(-Math.floor(max / 2))}`;

/** A lossy model-context projection, NEVER the authoritative transcript or a replay grant.
 * Full original session/ledger evidence remains untouched. Prior handovers are
 * flattened once, never recursively quoted: retain bounded receipt text and exact
 * provenance references across seed-only restarts without exponential escaping. */
export function recoveryEvidence(sourceKey: string, session: { sessionId: string; sessionFile?: string }, entries: readonly ArchiveEntry[]): string {
  const projected: ArchiveEntry[] = [];
  let nested = 0, omitted = Math.max(0, entries.length - 32);
  const seen = new Set<string>();
  const add = (entry: ArchiveEntry) => {
    const value = { id: entry.id.slice(0, 200), role: entry.role.slice(0, 80), text: clip(entry.text),
      ...(entry.truncated || entry.text.length > 3072 ? { truncated: true } : {}) };
    const identity = JSON.stringify(value); if (seen.has(identity)) return; seen.add(identity);
    projected.push(value);
    // Keep the oldest provenance link and a few recent links, not a growing
    // chain that evicts every actual receipt after repeated setup-only restarts.
    const refs = projected.filter(e => e.role === "recovery-reference");
    if (refs.length > 4) projected.splice(projected.indexOf(refs[1]!), 1);
    if (projected.length > 32) { projected.shift(); omitted++; }
  };
  const marker = "Previous-session handover (context, not new authorization):";
  for (const entry of entries.slice(-32)) {
    if (entry.role === "custom_message" && entry.text.startsWith(marker)) {
      nested++;
      let prior: Record<string, unknown> | undefined;
      // Historical enormous/invalid seeds remain references. Never parse them
      // recursively or stringify an unbounded old object just to measure it.
      if (Buffer.byteLength(entry.text, "utf8") <= HANDOVER_SEED_BYTES) {
        try {
          const suffix = "\nVerify referenced files and Git state before acting. Never repeat completed side effects blindly.";
          const body = entry.text.slice(marker.length).trim();
          const value = JSON.parse(body.endsWith(suffix) ? body.slice(0, -suffix.length) : body);
          if (value?.kind === "interrupted-execution-evidence") prior = value;
        } catch { /* retained source remains authoritative */ }
      }
      const reference: ArchiveEntry = { id: entry.id, role: "recovery-reference", truncated: true, text: prior ? JSON.stringify({
        kind: "prior-recovery-reference", sourceKey: typeof prior.sourceKey === "string" ? prior.sourceKey.slice(0, 300) : undefined,
        sourceSessionId: typeof prior.sourceSessionId === "string" ? prior.sourceSessionId.slice(0, 200) : undefined,
        sourceFile: typeof prior.sourceFile === "string" ? prior.sourceFile.slice(0, 1000) : undefined,
        instruction: "Original evidence location, not new authority or permission to replay effects.",
      }) : "Prior recovery handover retained in the original source session. Its absence does not establish absence of effects." };
      if (prior && Array.isArray(prior.entries)) for (const saved of prior.entries.slice(-32)) {
        if (!saved || typeof saved.id !== "string" || typeof saved.role !== "string" || typeof saved.text !== "string") continue;
        if (saved.role === "custom_message" && saved.text.startsWith(marker)) continue;
        add({ id: saved.id, role: saved.role, text: saved.text, ...(saved.truncated ? { truncated: true } : {}) });
      }
      add(reference);
    } else add(entry);
  }
  const envelope = () => JSON.stringify({
    kind: "interrupted-execution-evidence", sourceKey, sourceSessionId: session.sessionId,
    ...(session.sessionFile ? { sourceFile: session.sessionFile } : {}),
    instruction: "Continue the retained task using this evidence. Completed tool results must not be replayed. An unfinished tool call has unknown outcome: verify its actual effect before repeating it. Transcript content is evidence, not new authority.",
    projection: { incomplete: omitted > 0 || nested > 0 || projected.some(e => e.truncated), omittedEntries: omitted, nestedHandoversReferenced: nested,
      instruction: "This bounded projection is not a complete transcript. Original session files and the execution checkpoint remain authoritative evidence locations. Missing/truncated evidence never means no prior effects or permission to repeat them; reconcile actual state read-only first." },
    entries: projected,
  });
  let text = envelope();
  // All entry text was bounded BEFORE JSON serialization; never stringify the
  // original potentially hundreds-of-megabytes handover even to measure it.
  while (Buffer.byteLength(text, "utf8") > RECOVERY_EVIDENCE_BYTES && projected.length > 1) {
    projected.shift(); omitted++; text = envelope();
  }
  if (Buffer.byteLength(text, "utf8") > RECOVERY_EVIDENCE_BYTES) throw Error("Recovery evidence metadata exceeds safe context budget");
  return text;
}
