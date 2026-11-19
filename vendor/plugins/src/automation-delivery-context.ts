import type { Inbound } from "./types.js";

/** Delivery policy only: never changes the task's authority or work queue. */
export function automationDeliveryContext(input: Pick<Inbound, "source">): string {
  if (input.source !== "cron" && input.source !== "loop") return "";
  return `\nBackground automation delivery policy:
Continue the authorized work and save its results durably. Chat delivery is quiet by default, including generated continuations of this work.
Reply with exactly NO_REPLY when this turn only records routine progress, completed tickets, intermediate checks, or an internal continuation checkpoint. A substantive work result alone is not a reason to notify the operator.
Preserve reports explicitly requested by the operator or the automation's configured task, at the requested scope and cadence. An explicit aggregate report does not request individual ticket or continuation updates. Inspect the original task rather than treating a generated continuation as a request for a report.
Send a concise message when operator attention is genuinely needed, such as a decision, approval, actionable failure, or time-sensitive warning. Do not hide such a message behind NO_REPLY. Ordinary successful work and internally recoverable errors do not by themselves require attention.
This policy controls the outward reply, not whether to perform the work, checkpoint, or preserve evidence. It does not grant authority or alter task completion.\n`;
}
