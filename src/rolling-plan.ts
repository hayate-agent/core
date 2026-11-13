import type { SequentialState } from "./dispatcher-sequential.js";
import type { DispatchContext } from "./dispatcher.js";
import type { PlanHistoryRef } from "./execution.js";

/** Compact ONLY independently completed prefix steps. Remaining reports, unsafe
 * effects, routes, correction budgets and stable step IDs are exact, not reset. */
export async function archiveCompletedPrefix(state: SequentialState, context: DispatchContext, revision: number): Promise<SequentialState> {
  const count = state.outcomes.length;
  if (!count) return state;
  if (!context.archiveCompletedPlan) throw Error("Completed plan archival unavailable; retained evidence must not be discarded");
  const ids = state.stepIds ?? state.plan.map((_, index) => index);
  const history = await context.archiveCompletedPlan({ previous: state.planHistory,
    steps: state.outcomes.map((outcome, index) => ({ stepId: ids[index]!, step: state.plan[index]!, outcome })),
    followUps: state.appliedFollowUps ?? [],
  }, revision);
  const next: SequentialState = structuredClone(state);
  next.planHistory = history;
  next.nextStepId ??= Math.max(...ids) + 1;
  next.plan = next.plan.slice(count); next.stepIds = ids.slice(count); next.outcomes = [];
  const move = <T extends { index: number }>(value: T | undefined): T | undefined => value ? { ...value, index: value.index - count } : undefined;
  next.assessment = move(next.assessment); next.correction = move(next.correction); next.progress = move(next.progress);
  next.prior = move(next.prior); next.escalation = move(next.escalation);
  const parked = <T extends { index: number }>(value: T | undefined): T | undefined => value ? { ...value, index: 0 } : undefined;
  for (const held of next.deferred ?? []) {
    // Deferred positions describe their former window, not step identity. The
    // stable stepId binds them; restore always relocates to the then-current slot.
    held.assessment = parked(held.assessment)!; held.correction = parked(held.correction); held.progress = parked(held.progress);
    held.prior = parked(held.prior); held.escalation = parked(held.escalation);
  }
  for (const field of ["assessment", "correction", "progress", "prior", "escalation"] as const) if (next[field] === undefined) delete next[field];
  if (next.readyAdmission) next.readyAdmission.from -= count;
  if (!next.plan.length) throw Error("Cannot retire the complete active plan before its terminal receipt");
  // The archive is durable before this pointer commits. Parent amendments and
  // claim revocations are fenced AGAIN atomically with the new checkpoint.
  await context.checkpoint(JSON.stringify(next), undefined, revision);
  return next;
}
export function validPlanHistory(value: PlanHistoryRef | undefined): boolean {
  return value === undefined || !!value && /^[a-f0-9]{64}$/.test(value.head) &&
    Number.isSafeInteger(value.completed) && value.completed > 0 && Number.isSafeInteger(value.segments) && value.segments > 0 &&
    Number.isSafeInteger(value.maxStepId) && value.maxStepId >= 0;
}
