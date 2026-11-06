import type { Execution } from "./execution.js";

/** Trusted optional policy, not an instruction returned by a worker. */
export interface ExecutionRecoveryPolicy {
  name: string;
  /** Return an actionable blocker, or undefined to use the strategy's recovery. */
  evaluate(task: Readonly<Execution>): string | undefined;
}
export interface RecoveryStrategy {
  version: number;
  replaySafe: boolean;
  /** Recovery consumes retained evidence instead of replaying opaque effects. */
  reconcile?: boolean;
}
export function recoveryBlock(task: Execution, strategy?: RecoveryStrategy, policy?: ExecutionRecoveryPolicy): string | undefined {
  if (!strategy || strategy.version !== task.strategyVersion) return `Strategy ${task.strategy}@${task.strategyVersion} unavailable; restore the matching plugin, then resolve and resume.`;
  const grant = task.recoveryGrant?.restarts === task.restarts ? task.recoveryGrant : undefined;
  if (!grant) {
    const reason = policy?.evaluate(structuredClone(task));
    if (reason) return reason;
  }
  if (task.intent && !strategy.reconcile && !(task.intent.replay === "safe" && strategy.replaySafe)) {
    if (grant?.action === "retry") return;
    return "Uncertain effect: strategy has no reconciliation support. Inspect evidence, then explicitly resolve retry (duplicates possible), or cancel.";
  }
}
