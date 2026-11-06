import { createHash } from "node:crypto";
import type { PruningPolicy, ProjectionMessage } from "./tool-result-pruning.js";

function text(message: ProjectionMessage): string | undefined {
  if (!Array.isArray(message.content) || !message.content.length || message.content.some((part) => part?.type !== "text" || typeof part.text !== "string")) return undefined;
  return message.content.map((part) => part.text).join("\n");
}

/** Pure per-request projection. Never mutates transcripts, tool IDs, errors, images or recent results. */
export function pruneToolResults<T extends ProjectionMessage>(messages: T[], policy: PruningPolicy): T[] {
  if (!policy.enabled) return messages;
  const results = messages.map((m, index) => ({ m, index, body: m.role === "toolResult" ? text(m) : undefined })).filter((r) => r.m.role === "toolResult");
  const totalBytes = results.reduce((sum, r) => sum + (r.body === undefined ? 0 : Buffer.byteLength(r.body)), 0);
  if (totalBytes / 4 < policy.proactivePruneTokens) return messages;
  const protectedFrom = Math.max(0, results.length - policy.keepRecent);
  const seen = new Map<string, string>();
  const replacements = new Map<number, T>();
  for (let i = 0; i < results.length; i++) {
    const { m, index, body } = results[i];
    if (body === undefined || m.isError || !m.toolCallId || body.length < policy.minResultChars) continue;
    const digest = createHash("sha256").update(JSON.stringify([m.toolName, m.content])).digest("hex");
    const previous = seen.get(digest);
    // Protected results still establish the digest only after older candidates have been handled.
    if (i < protectedFrom) {
      const marker = `[Older tool result shortened for model context only; original remains in session history. toolCallId=${m.toolCallId}; sha256=${digest}; originalChars=${body.length}. Re-read the source or request the original if needed.]`;
      let projected: string;
      if (previous) projected = `${marker}\nExact duplicate of toolCallId=${previous}.`;
      else {
        const room = Math.max(0, policy.maxResultChars - marker.length - 40);
        let head = Math.floor(room * 0.65);
        let tailStart = body.length - (room - head);
        // Move cut points inward rather than leaving half a surrogate pair in an excerpt.
        if (head > 0 && /[\uD800-\uDBFF]/.test(body[head - 1])) head--;
        if (tailStart < body.length && /[\uDC00-\uDFFF]/.test(body[tailStart])) tailStart++;
        projected = `${marker}\n${body.slice(0, head)}\n[… middle omitted …]\n${body.slice(tailStart)}`;
      }
      // Metadata and duplicate references count toward the cap too. Tool identity
      // remains in the message fields even if a long textual marker is shortened.
      if (projected.length > policy.maxResultChars) {
        const suffix = " [truncated]";
        let end = policy.maxResultChars - suffix.length;
        const code = projected.charCodeAt(end - 1);
        if (code >= 0xd800 && code <= 0xdbff) end--;
        projected = projected.slice(0, end) + suffix;
      }
      replacements.set(index, { ...m, content: [{ type: "text", text: projected }] } as T);
    }
    if (!previous) seen.set(digest, m.toolCallId);
  }
  return replacements.size ? messages.map((m, i) => replacements.get(i) ?? m) : messages;
}
