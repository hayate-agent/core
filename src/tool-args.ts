/**
 * Prepare tool call arguments for validation.
 *
 * Some models (notably glm-5.3-flash on the homelab provider) emit structured
 * tool arguments double-encoded: the model's own tool-call JSON contains the
 * value of an array- or object-typed property as a JSON string instead of a
 * real array or object. PI's argument validation cannot coerce a string into
 * an array or object (see pi-ai validateToolArguments), so such calls fail
 * with "must be array/object". The pi ToolDefinition.prepareArguments hook
 * runs before validation, so plugin tools registered by the harness get this
 * shim to parse string-encoded structured arguments back into their declared
 * shape. Only the declared shape decides: a parse that does not yield the
 * property's declared type is left alone so validation reports the real
 * failure.
 */
// JSON.parse itself accepts leading JSON whitespace (space, tab, LF, CR).
const STRUCTURED_PREFIX = /^[ \t\r\n]*[[{]/;

export function prepareStructuredToolArgs(parameters: unknown, args: unknown): unknown {
  if (typeof args === "string" && STRUCTURED_PREFIX.test(args)) {
    try {
      const parsed = JSON.parse(args);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return args;
      args = parsed;
    } catch {
      return args;
    }
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const properties = (parameters as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (!properties || typeof properties !== "object") return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  let changed = false;
  for (const [key, property] of Object.entries(properties)) {
    const value = out[key];
    if (typeof value !== "string" || !STRUCTURED_PREFIX.test(value)) continue;
    const declared = (property as { type?: unknown } | undefined)?.type;
    // A nullable structured type still has one unambiguous decoded shape.
    // Other unions remain untouched so validation can report the real error.
    const type = Array.isArray(declared) && declared.length === 2 && declared.includes("null")
      ? declared.find(value => value !== "null")
      : declared;
    if (type !== "array" && type !== "object") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      continue;
    }
    if (type === "array") {
      if (!Array.isArray(parsed)) continue;
    } else if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    out[key] = parsed;
    changed = true;
  }
  return changed ? out : args;
}
