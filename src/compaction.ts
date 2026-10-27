/** Compaction implementations reuse runtime capabilities rather than reinterpret history. */
export interface CompactionStrategy {
  compact(context: { instructions?: string; compactNative(instructions?: string): Promise<void> }): Promise<void>;
}
export const nativeCompaction: CompactionStrategy = {
  compact: ({ instructions, compactNative }) => compactNative(instructions),
};

/** Stable forwarding adapter for owner-managed sessions. Registry entries must
 * already be validated/receiver-bound. Embedded fixed-strategy sessions are unchanged.
 * No no-op disable: use native to remove an optional wrapper.
 */
export class CompactionSelection implements CompactionStrategy {
  private selected: string;
  private changing = false;
  private running = 0;
  constructor(private readonly registry: ReadonlyMap<string, CompactionStrategy>, readonly baseline: string) {
    this.resolve(baseline);
    this.selected = baseline;
  }
  get active(): string { return this.selected; }
  names(): string[] { return ["native", ...this.registry.keys()]; }
  private resolve(name: string): CompactionStrategy {
    const strategy = name === "native" ? nativeCompaction : this.registry.get(name);
    if (!strategy) throw Error(`Unknown compaction strategy: ${name}`);
    return strategy;
  }
  async change(selection: string | undefined, persist: (selection: string | undefined) => Promise<void>): Promise<void> {
    if (this.changing || this.running) throw Error("Compaction strategy busy");
    this.changing = true;
    try {
      const name = selection ?? this.baseline;
      this.resolve(name);
      await persist(selection);
      this.selected = name;
    } finally { this.changing = false; }
  }
  async compact(context: Parameters<CompactionStrategy["compact"]>[0]): Promise<void> {
    if (this.changing) throw Error("Compaction strategy changing; retry after current change");
    const strategy = this.resolve(this.selected);
    this.running++;
    try { await strategy.compact(context); } finally { this.running--; }
  }
}
