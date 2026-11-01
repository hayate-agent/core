import type { ArchiveEntry } from "./session-archive.js";

/** References only. Text remains in the runtime's scoped transcript. */
export interface HashtagReference {
  tag: string;
  sessionId: string;
  messageId: string;
  date: string;
}

/** Deliberately conservative: only whitespace-delimited ASCII #slugs on plain
 * lines. Skip fenced/indented code, Markdown quotes, inline code/quotes, links
 * and XML-style blocks (including pasted untrusted-source wrappers). */
export function parseHashtags(text: string): string[] {
  const tags = new Set<string>();
  let fence: string | undefined;
  let block = 0;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker[0]; else if (marker[0] === fence) fence = undefined; continue; }
    if (fence) continue;
    if (/^\s*</.test(line)) {
      for (const tag of line.matchAll(/<\/?[a-zA-Z][^>]*>/g)) {
        if (tag[0].startsWith("</")) block = Math.max(0, block - 1);
        else if (!tag[0].endsWith("/>")) block++;
      }
      continue;
    }
    if (block || /^(?: {4}|\t)|^\s*>/.test(line)) continue;
    // Unbalanced quoting is ambiguous; ignore the remainder rather than infer intent.
    const plain = line.replace(/`[^`]*(?:`|$)|"[^"]*(?:"|$)|'[^']*(?:'|$)|\[[^\]]*\]\([^)]*\)/g, " ");
    for (const match of plain.matchAll(/(?:^|\s)#([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*)(?=$|\s|[.,!?;:])/g)) tags.add(match[1].toLowerCase());
  }
  return [...tags].sort();
}

/** Canonical labels are host metadata, never inferred from returned text. */
export function labelOutput(text: string, tags?: readonly string[]): string {
  if (!text || !tags?.length) return text;
  const prefix = [...new Set(tags)].sort().map(tag => `#${tag}`).join(" ") + " · ";
  // Replace model/worker-generated envelope labels rather than accumulating them.
  return prefix + text.replace(/^(?:#[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*\s+)+·\s*/g, "");
}

export function hashtagReferences(sessionId: string, text: string, entries: ArchiveEntry[], date: string, previousIds: Set<string>): HashtagReference[] {
  const tags = parseHashtags(text);
  if (!tags.length) return [];
  // Only a real user transcript entry can be referenced, never a tool observation.
  const message = entries.findLast(entry => !previousIds.has(entry.id) && entry.role === "user" && entry.text.includes(text));
  return message ? tags.map(tag => ({ tag, sessionId, messageId: message.id, date })) : [];
}

export function transcriptEntries(entries: unknown[]): ArchiveEntry[] {
  return entries.map((raw) => {
    const entry = raw as { id: string; type: string; message?: { role: string; content: unknown } };
    const msg = entry.type === "message" ? entry.message : undefined;
    const text = typeof msg?.content === "string" ? msg.content : Array.isArray(msg?.content)
      ? msg.content.filter(c => c?.type === "text").map(c => c.text).join("\n") : "";
    return { id: entry.id, role: msg?.role ?? entry.type, text };
  });
}
