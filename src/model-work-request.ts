import { createHash } from "node:crypto";

/** v2 model-independent JSON identity. The gateway may rewrite ONLY root.model.
 * Numbers are canonical IEEE-754 binary64 (both JSON runtimes use that domain),
 * strings/keys are exact UTF-8 and object keys sorted by UTF-8 bytes. Typed,
 * length-prefixed tokens avoid collisions between JSON types/concatenations.
 */
export function modelWorkRequestIdentity(body: string): { digest: string; model: unknown; oneToken: boolean } {
  if (Buffer.byteLength(body) > 16 * 1024 * 1024) throw Error("Scheduling body limit");
  let quoted = false, escaped = false, depth = 0, structural = 0;
  for (const char of body) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{" || char === "[") { depth++; structural++; if (depth > 65) throw Error("Scheduling JSON depth limit"); }
    else if (char === "}" || char === "]") depth--;
    else if (char === "," || char === ":") structural++;
    if (structural > 100_000) throw Error("Scheduling JSON allocation limit");
  }
  const parsed: unknown = JSON.parse(body);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw Error("Scheduling JSON object required");
  const hash = createHash("sha256");
  let nodes = 0;
  const count = (tag: string, length: number) => {
    const prefix = Buffer.alloc(5); prefix.write(tag, 0, "ascii"); prefix.writeUInt32BE(length, 1); hash.update(prefix);
  };
  const walk = (value: unknown, depth: number): void => {
    if (++nodes > 200_000 || depth > 64) throw Error("Scheduling JSON complexity limit");
    if (value === null) { hash.update("n"); return; }
    if (typeof value === "boolean") { hash.update(value ? "t" : "f"); return; }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw Error("Scheduling finite safe JSON number required");
      const raw = Buffer.alloc(9); raw.write("d"); raw.writeDoubleBE(value === 0 ? 0 : value, 1); hash.update(raw); return;
    }
    if (typeof value === "string") {
      // Reject lone surrogates; UTF-8 replacement must not collapse identities.
      for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
          const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw Error("Scheduling Unicode required");
        } else if (c >= 0xdc00 && c <= 0xdfff) throw Error("Scheduling Unicode required");
      }
      const raw = Buffer.from(value); count("s", raw.length); hash.update(raw); return;
    }
    if (Array.isArray(value)) { count("a", value.length); for (const item of value) walk(item, depth + 1); return; }
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter(key => depth !== 0 || key !== "model")
        .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      count("o", keys.length); for (const key of keys) { walk(key, depth + 1); walk(record[key], depth + 1); } return;
    }
    throw Error("Scheduling JSON value required");
  };
  walk(parsed, 0);
  const record = parsed as Record<string, unknown>;
  return { digest: hash.digest("hex"), model: record.model,
    oneToken: [record.max_tokens, record.max_completion_tokens, record.max_output_tokens].some(value => value === 1) };
}
export function modelWorkRequestDigest(body: string): string { return modelWorkRequestIdentity(body).digest; }

