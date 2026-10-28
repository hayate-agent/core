/** Only host-created guard denials receive a specific, model-visible reason.
 * Never forward an arbitrary exception's message, properties or string conversion.
 */
export type ToolGuardCode = "review_required" | "worker_orchestration_denied" | "authority_revoked" | "dispatcher_unavailable" | "continuation_budget_exhausted";

const codes = new WeakMap<object, ToolGuardCode>();

export class ToolGuardError extends Error {
  constructor(code: ToolGuardCode, message: string) {
    super(message);
    this.name = "ToolGuardError";
    codes.set(this, code);
  }
}

export function toolGuardDenialReason(error: unknown): string {
  const code = error !== null && (typeof error === "object" || typeof error === "function") ? codes.get(error) : undefined;
  switch (code) {
    case "review_required": return "review_required: Core review gate blocked this action; review the current changeset first.";
    case "worker_orchestration_denied": return "worker_orchestration_denied: Tool orchestration is not permitted in this execution context; return a result or blocker.";
    case "authority_revoked": return "authority_revoked: Execution authority is no longer valid; this action is blocked.";
    case "continuation_budget_exhausted": return "continuation_budget_exhausted: Productive follow-up budget exhausted; no work tool was executed. Status-only dependency rechecks remain allowed until the fixed deadline. Record waiting or a blocked next step; do not disguise productive work as waiting.";
    case "dispatcher_unavailable": return "dispatcher_unavailable: The required dispatcher is unavailable; this action is blocked.";
    default: return "Tool guard blocked this action; authorization could not be established.";
  }
}
