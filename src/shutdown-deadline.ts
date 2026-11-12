/** One wall-clock budget for all shutdown owners, snapshot retries and cleanup.
 * It never grants a fresh timeout to a later phase. The final callback belongs
 * to the process owner; releasing a Home lock before that process exits is unsafe.
 */
export class ShutdownDeadline {
  private readonly end: number;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(milliseconds: number, expire: () => void, private readonly now = Date.now) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1 || milliseconds > 3_600_000) throw Error("Invalid shutdown deadline");
    this.end = now() + milliseconds;
    this.timer = setTimeout(expire, milliseconds);
  }
  remaining(reserve = 0): number { return Math.max(0, this.end - this.now() - reserve); }
  async wait<T>(work: Promise<T>, maximum: number, fallback: () => T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<T>(resolve => {
        timer = setTimeout(() => resolve(fallback()), Math.min(Math.max(0, maximum), this.remaining()));
      })]);
    } finally { clearTimeout(timer); }
  }
  close(): void { clearTimeout(this.timer); }
}
