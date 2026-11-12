/** Scheduling metadata only: never authorization, a resume grant, or preemption. */
export type TaskPriority = "low" | "normal" | "high";
export function isTaskPriority(value: unknown): value is TaskPriority {
  return value === "low" || value === "normal" || value === "high";
}
export function priorityRank(value: unknown): number {
  return value === "high" ? 2 : value === "low" ? 0 : 1;
}

/** Prefer urgent runnable work, but yield one of every five selections to the
 * other priorities. Round robin within both groups prevents permanent starvation.
 * Only the labels are durable; restart resets this bounded fairness cursor. */
export class PriorityScheduler {
  private preferredRuns = 0;
  private lastPreferred?: string;
  private lastYield?: string;
  pick<T>(items: readonly T[], id: (item: T) => string, priority: (item: T) => unknown, after?: string): T | undefined {
    if (!items.length) return;
    const highest = Math.max(...items.map(item => priorityRank(priority(item))));
    const top = items.filter(item => priorityRank(priority(item)) === highest);
    const lower = items.filter(item => priorityRank(priority(item)) < highest);
    const yieldTurn = this.preferredRuns >= 4 && lower.length > 0;
    const group = yieldTurn ? lower : top;
    const previous = yieldTurn ? this.lastYield : this.lastPreferred ?? after;
    const index = group.findIndex(item => id(item) === previous);
    const selected = group[(index + 1) % group.length];
    if (yieldTurn) { this.lastYield = id(selected); this.preferredRuns = 0; }
    else { this.lastPreferred = id(selected); this.preferredRuns = Math.min(4, this.preferredRuns + 1); }
    return selected;
  }
}
