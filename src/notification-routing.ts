import { createHash } from "node:crypto";
import type { Address, Channel } from "./types.js";

/** A status is not a conversation answer. Editable adapters retain one logical
 * row per task. Legacy adapters get an explicit status line, never a silent drop. */
export const taskStatusId = (key: string): string => `native:status:${createHash("sha256").update(key).digest("hex")}`;

export async function deliverTaskStatus(channel: Channel, to: Address, key: string, text: string): Promise<void> {
  const id = taskStatusId(key);
  await channel.send(to, text, channel.editableProgress
    ? { presentation: "progress", progressId: id }
    : { presentation: "progress" });
}

export function attentionRequired(event: import("./execution.js").ExecutionEvent, current: string): boolean {
  const status = event.status ?? current;
  if (event.requiresAttention) return true;
  if (event.type === "status" && Number.isSafeInteger(event.automaticRetryAt) && event.automaticRetryAt! > 0) return false;
  return event.type === "question" || ["blocked", "paused", "cancelled"].includes(status);
}

/** Dispatcher telemetry stays in /dispatch and API progress, never ordinary chat.
 * Routing is independent of parent session prefixes: cron continuations can own
 * a Matrix parent too. Only questions and actionable state changes reach chat. */
export function dispatcherEventPresentation(event: import("./execution.js").ExecutionEvent, current: string, channel?: string): "progress" | "attention" | undefined {
  if (event.type !== "status" && event.type !== "question") return;
  if (channel === "api") return "progress";
  return attentionRequired(event, current) ? "attention" : undefined;
}

/** An unchanged wait is necessary, never sufficient: the producer must positively
 * designate the ENTIRE reply as routine (no partial result or attention request).
 * Missing designation, failures, changed conditions and blockers remain chat.
 * This is structured producer intent, not an inference from reply prose. */
export function routineWait(input: import("./types.js").Inbound, outcome?: string): boolean {
  const before = input.waitRecheck;
  const after = input.continuation;
  return input.source === "cron" && !!before && !outcome && after?.replyKind === "routine" && after.state === "waiting" &&
    !!after.wait && after.wait.reason === before.reason && after.next === before.next;
}
