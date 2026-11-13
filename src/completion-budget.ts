import type { Inbound } from "./types.js";
import type { CompletionAuthorization, CompletionPrompt } from "./completion-check.js";

/** Includes instructions, JSON escaping and metadata. ceil(UTF16 length / 3.5)
 * <= 16000 is an estimate, NOT an actual model-token guarantee. */
export const COMPLETION_PROMPT_LIMIT = 56000;
export function fitsCompletionPrompt(prompt: unknown): prompt is string {
  return typeof prompt === "string" && prompt.length <= COMPLETION_PROMPT_LIMIT && Buffer.byteLength(prompt, "utf8") <= COMPLETION_PROMPT_LIMIT;
}

export function prefix(text: string, limit: number): string {
  let end = Math.min(text.length, Math.max(0, limit));
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}

/** Only known tool envelopes are normalized. Old mixed/cut formats remain
 * explicitly incomplete legacy text. IDs are never shortened or invented. */
export function projectObservation(text: string, role: string, limit: number): { text: string; truncated: boolean; totalChars: number } {
  const result = (value: string, truncated: boolean) => ({ text: value, truncated, totalChars: text.length });
  if (text.length <= limit) return result(text, false);
  let payload: Record<string, any> | undefined;
  try { payload = JSON.parse(text); } catch { /* Do not repair legacy JSON. */ }
  const tool = (value: Record<string, any>, size: number): object => {
    const call = value.type === "toolCall";
    const ids = call ? [value.id, value.name] : [value.toolCallId, value.toolName];
    if (ids.some(id => typeof id !== "string" || id.length > 256)) return { omitted: true, reason: "invalid-tool-identity" };
    if (call) {
      const args = typeof value.argumentsExcerpt === "string" ? value.argumentsExcerpt : JSON.stringify(value.arguments) ?? "";
      return { type: "toolCall", id: value.id, name: value.name, argumentsExcerpt: prefix(args, size), argumentsTotalChars: value.argumentsTotalChars ?? args.length, truncated: true };
    }
    const content = typeof value.text === "string" ? value.text : "";
    return { type: "toolResult", toolCallId: value.toolCallId, toolName: value.toolName, isError: value.isError === true,
      text: prefix(content, size), totalChars: value.totalChars ?? content.length, truncated: true };
  };
  const render = (size: number): string => {
    if (payload?.type === "toolCall" || payload?.type === "toolResult") return JSON.stringify(tool(payload, size));
    if (payload?.type === "assistantBlocks" && Array.isArray(payload.blocks)) {
      const blocks = payload.blocks.slice(-16).map((block: Record<string, any>) => block?.type === "toolCall" ? tool(block, Math.floor(size / 16))
        : { type: "text", text: prefix(typeof block?.text === "string" ? block.text : "", Math.floor(size / 16)), truncated: true });
      return JSON.stringify({ type: "assistantBlocks", blocks, truncated: true, omittedBlocks: Math.max(0, payload.blocks.length - 16) });
    }
    return JSON.stringify({ source: "legacy-text", incomplete: true, totalChars: text.length, excerpt: prefix(text, size) });
  };
  // The serialized envelope itself, not just its payload, must fit the record cap.
  if (render(0).length > limit) return result(JSON.stringify({ omitted: true, reason: "record-budget" }), true);
  let low = 0, high = Math.min(text.length, limit);
  let accepted = render(0);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), candidate = render(middle);
    if (candidate.length <= limit) { accepted = candidate; low = middle + 1; } else high = middle - 1;
  }
  return result(accepted, true);
}

/** One existing collector; immutable projection only. Each candidate is fully
 * rendered and measured. No final-string slicing and no model-selected evidence. */
export function renderCompletionPrompt(strategy: CompletionPrompt, input: Inbound, reply: string,
  authorization: CompletionAuthorization, now: () => number): string | undefined {
  const clock = now();
  const render = (value: Inbound, response: string) => strategy(value, response, authorization, () => clock);
  const full = render(input, reply);
  if (fitsCompletionPrompt(full)) return full;
  const resolved = input.completionContext?.resolved;
  const selected = resolved?.ingress.find(entry => entry.id === resolved.taskId);
  const projected: Inbound = { ...input, text: "[request omitted: exact authorization retained]", completionContext: {
    ...(resolved ? { resolved: { ...resolved, ingress: selected ? [selected] : [], observations: [], incomplete: true,
      omittedObservations: resolved.observations.length } } : {}), recent: [], tasks: [],
  } };
  let response = "[reply omitted: prompt budget]";
  let accepted = render(projected, response);
  if (!fitsCompletionPrompt(accepted)) return undefined;
  // Fit a payload using the real renderer. Every attempted candidate is bounded
  // by existing entry counts and logarithmic payload search, including plugins.
  const fit = (maximum: number, apply: (size: number) => void): boolean => {
    let low = 0, high = maximum, best = -1;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2); apply(middle);
      const candidate = render(projected, response);
      if (fitsCompletionPrompt(candidate)) { best = middle; accepted = candidate; low = middle + 1; } else high = middle - 1;
    }
    if (best < 0) return false;
    apply(best); return true;
  };
  // Task-bound state survives the budget fallback before transcript evidence:
  // original mandate, saved next/technical state, worker outcomes, then recent
  // messages (newest first). Shortened sections are named in `truncated`.
  const retained = input.completionContext?.retained;
  const kept = retained && { original: "", technical: retained.technical, ...(retained.runtime ? { runtime: retained.runtime } : {}), truncated: [] as string[],
    ...(retained.savedNext !== undefined ? { savedNext: "" } : {}),
    ...(retained.parentReconciliation !== undefined ? { parentReconciliation: "" } : {}),
    recentMessages: [] as NonNullable<typeof retained.recentMessages>,
    ...(retained.workers ? { workers: { ...retained.workers, items: [] as typeof retained.workers.items } } : {}) };
  if (retained && kept) {
    projected.completionContext!.retained = kept;
    const mark = (section: string) => { if (!kept.truncated.includes(section)) kept.truncated.push(section); };
    if (!fit(retained.original.length, size => { kept.original = prefix(retained.original, size); })) kept.original = "";
    if (kept.original.length < retained.original.length) mark("original");
    if (retained.savedNext !== undefined) {
      if (!fit(retained.savedNext.length, size => { kept.savedNext = prefix(retained.savedNext!, size); })) kept.savedNext = "";
      if (kept.savedNext!.length < retained.savedNext.length) mark("savedNext");
    }
    if (retained.parentReconciliation !== undefined) {
      if (!fit(retained.parentReconciliation.length, size => { kept.parentReconciliation = prefix(retained.parentReconciliation!, size); })) kept.parentReconciliation = "";
      if (kept.parentReconciliation!.length < retained.parentReconciliation.length) mark("parentReconciliation");
    }
    for (const item of retained.workers?.items ?? []) {
      const { result, ...meta } = item;
      const record: typeof item = { ...meta };
      kept.workers!.items.push(record);
      if (result === undefined) { if (!fitsCompletionPrompt(render(projected, response))) { kept.workers!.items.pop(); kept.workers!.omitted++; mark("workers"); } continue; }
      if (!fit(Math.min(1000, result.length), size => { record.result = prefix(result, size); if (size < result.length) record.truncated = true; else delete record.truncated; })) {
        kept.workers!.items.pop(); kept.workers!.omitted++; mark("workers");
      } else if (record.truncated) mark("workers");
    }
    for (const message of [...retained.recentMessages ?? []].reverse()) {
      const record: typeof message = { role: message.role, text: "" };
      kept.recentMessages.unshift(record);
      const total = message.totalChars ?? message.text.length;
      if (!fit(Math.min(1000, message.text.length), size => { record.text = prefix(message.text, size);
        if (size < message.text.length || message.truncated) { record.truncated = true; record.totalChars = total; } else { delete record.truncated; delete record.totalChars; } })) {
        kept.recentMessages.shift(); mark("recentMessages");
      } else if (record.truncated) mark("recentMessages");
    }
    if (retained.priorReply !== undefined) mark("priorReply");
  }
  // Latest current branch first, then the latest settled reply, then archives.
  const target = projected.completionContext?.resolved;
  const addObservations = (source: "current" | "archive") => {
    if (!resolved || !target) return;
    for (const observation of [...resolved.observations].reverse().filter(entry => (entry.source ?? "archive") === source)) {
      const record = { ...observation };
      target.observations.unshift(record); target.omittedObservations!--;
      if (!fit(Math.min(8000, observation.text.length), size => {
        const projection = projectObservation(observation.text, observation.role, size);
        Object.assign(record, projection, { totalChars: observation.totalChars ?? projection.totalChars, truncated: observation.truncated || projection.truncated });
      })) { target.observations.shift(); target.omittedObservations!++; }
    }
  };
  addObservations("current");
  const oldResponse = response;
  if (!fit(Math.min(reply.length, 16000), size => { response = prefix(reply, size) + (reply.length > size ? "\n[reply truncated]" : ""); })) response = oldResponse;
  addObservations("archive");
  if (resolved && target) {
    for (const entry of [...resolved.ingress].reverse()) {
      if (entry === selected) continue;
      target.ingress.push(entry);
      const candidate = render(projected, response);
      if (fitsCompletionPrompt(candidate)) accepted = candidate; else target.ingress.pop();
    }
    // Restore the original mechanical ordering after priority selection.
    target.observations.sort((a, b) => resolved.observations.indexOf(resolved.observations.find(entry => entry.digest === a.digest)!) - resolved.observations.indexOf(resolved.observations.find(entry => entry.digest === b.digest)!));
    target.ingress.sort((a, b) => resolved.ingress.indexOf(a) - resolved.ingress.indexOf(b));
    target.incomplete = resolved.incomplete || !!target.omittedObservations || target.observations.some(entry => entry.truncated) || target.ingress.length !== resolved.ingress.length;
  } else if (input.completionContext) {
    // Legacy host contexts still get bounded latest fallback evidence.
    for (const entry of [...input.completionContext.recent].reverse().slice(0, 8)) {
      projected.completionContext!.recent.unshift({ ...entry, text: "" });
      if (!fit(Math.min(2000, entry.text.length), size => { projected.completionContext!.recent[0].text = prefix(entry.text, size); })) projected.completionContext!.recent.shift();
    }
  }
  const final = render(projected, response);
  return fitsCompletionPrompt(final) ? final : fitsCompletionPrompt(accepted) ? accepted : undefined;
}
