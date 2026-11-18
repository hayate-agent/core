import { access, readFile } from "node:fs/promises";
import { createReadToolDefinition, detectSupportedImageMimeTypeFromFile } from "@earendil-works/pi-coding-agent";
import { boundedReadDetails, READ_RANGE_CODEPOINTS, readResultHash } from "../bounded-read-result.js";

/** Locate codepoint cursors without allocating an array for a very long line. */
function lineRange(text: string, column: number, limit: number) {
  let index = 0, skipped = 0;
  while (index < text.length && skipped < column) {
    index += text.codePointAt(index)! > 0xffff ? 2 : 1; skipped++;
  }
  if (skipped !== column) throw new Error(`charOffset ${column} is beyond line (${skipped} codepoints)`);
  const start = index;
  let count = 0;
  while (index < text.length && count < limit) {
    index += text.codePointAt(index)! > 0xffff ? 2 : 1; count++;
  }
  return { text: text.slice(start, index), count, atEnd: index === text.length };
}

/** Reuse SDK path resolution, file access, image handling and cancellation. Only
 * text projection differs: return a source range, not an excerpt of an excerpt. */
export function createBoundedReadTool(cwd: string) {
  const base = createReadToolDefinition(cwd);
  return {
    ...base,
    description: "Read file text or images. Text returns up to 3000 Unicode codepoints with source hash, exact range and next arguments. Locate missing evidence first; use offset/limit for relevant lines, charOffset (0-based codepoints within the starting line) for long lines. Continue only when needed, not to reload entire files. Images use native SDK handling.",
    parameters: { ...base.parameters, properties: { ...base.parameters.properties,
      charOffset: { type: "integer" as const, minimum: 0, description: "0-based Unicode codepoint offset within the starting line; use returned continuation arguments." },
    } },
    async execute(...args: Parameters<typeof base.execute>) {
      const [id, input, signal, onUpdate, ctx] = args;
      const charOffset = (input as typeof input & { charOffset?: number }).charOffset ?? 0;
      for (const [name, value] of [["offset", input.offset ?? 1], ["limit", input.limit ?? 2000], ["charOffset", charOffset]] as const) {
        if (!Number.isSafeInteger(value) || value < (name === "charOffset" ? 0 : 1)) throw new Error(`Invalid read ${name}`);
      }
      let snapshot: Buffer | undefined, source = "", image = false;
      const sdk = createReadToolDefinition(cwd, { operations: {
        access: p => access(p), detectImageMimeType: async p => {
          const mime = await detectSupportedImageMimeTypeFromFile(p); image = !!mime; return mime;
        },
        readFile: async p => { source = p; snapshot = await readFile(p, { signal }); return snapshot; },
      } });
      const original = await sdk.execute(id, input, signal, onUpdate, ctx);
      signal?.throwIfAborted();
      // Images and native notes/errors keep their original machine/image data.
      if (!snapshot || image) return original;
      const text = snapshot.toString("utf8"), lines = text.split("\n");
      const start = (input.offset ?? 1) - 1;
      const end = Math.min(lines.length, start + (input.limit ?? 2000));
      let line = start, column = charOffset, remaining = READ_RANGE_CODEPOINTS, body = "", eof = false;
      // Cursor refers to ORIGINAL lines, including when a line exceeds the budget.
      while (line < end && remaining > 0) {
        const selected = lineRange(lines[line]!, column, remaining);
        body += selected.text; remaining -= selected.count; column += selected.count;
        if (!selected.atEnd) break;
        if (line + 1 >= lines.length) { eof = true; break; }
        if (!remaining) break;
        if (line + 1 >= end) { body += "\n"; remaining--; line++; column = 0; break; }
        body += "\n"; remaining--; line++; column = 0;
      }
      const next = eof ? null : { path: source, offset: line + 1, charOffset: column, ...(input.limit === undefined ? {} : { limit: input.limit }) };
      const result = `[Read range: ${JSON.stringify({ source, sha256: readResultHash(text), start: { offset: start + 1, charOffset }, end: { offset: line + 1, charOffset: column }, next, totalLines: lines.length })}]\n${body}`;
      return { content: [{ type: "text" as const, text: result }], structuredContent: result, details: { ...boundedReadDetails(result), truncation: undefined } };
    },
  };
}
