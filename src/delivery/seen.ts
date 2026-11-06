// SPDX-License-Identifier: Apache-2.0
/**
 * Bounded window of accepted input ids (persisted): a turn starts exactly once per id across
 * redeliveries and restarts. Channels whose upstream acknowledgement lags acceptance (Matrix
 * sync cursor) pin ids until their checkpoint is durable; pinned ids are never evicted.
 */
export class SeenWindow {
  static readonly MAX = 2000;
  private readonly seen = new Set<string>();
  private readonly pinned = new Set<string>();
  /** Restored at startup, pinned until the first post-restart channel checkpoint. */
  private readonly provisional = new Set<string>();

  constructor(private readonly max = SeenWindow.MAX) {}

  has(id: string): boolean {
    return this.seen.has(id);
  }

  mark(id: string): void {
    this.seen.delete(id); // re-insert = most recent
    this.seen.add(id);
    this.trim();
  }

  unmark(id: string): void {
    this.seen.delete(id);
  }

  pin(ids: Iterable<string>): void {
    for (const id of ids) this.pinned.add(id);
  }

  unpin(ids: Iterable<string>): void {
    for (const id of ids) this.pinned.delete(id);
    // A durable checkpoint after restart covers the pre-restart window too.
    for (const id of this.provisional) this.pinned.delete(id);
    this.provisional.clear();
    this.trim();
  }

  /**
   * Restored ids may include a channel's uncommitted window from before the restart: keep them
   * all (pinned) until a channel durably commits its first checkpoint after startup.
   */
  restore(ids: Iterable<string>): void {
    for (const id of ids) {
      this.seen.add(id);
      this.pinned.add(id);
      this.provisional.add(id);
    }
  }

  ids(exclude: ReadonlySet<string> = new Set()): string[] {
    return [...this.seen].filter((id) => !exclude.has(id));
  }

  private trim(): void {
    for (const old of this.seen) {
      if (this.seen.size <= this.max) break;
      if (!this.pinned.has(old)) this.seen.delete(old);
    }
  }
}
