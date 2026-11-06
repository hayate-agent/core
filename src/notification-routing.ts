// SPDX-License-Identifier: Apache-2.0
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
  return event.type === "question" || ["blocked", "paused", "cancelled"].includes(status);
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
