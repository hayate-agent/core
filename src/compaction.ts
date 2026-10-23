/** Compaction implementations reuse runtime capabilities rather than reinterpret history. */
export interface CompactionStrategy {
  compact(context: { instructions?: string; compactNative(instructions?: string): Promise<void> }): Promise<void>;
}
export const nativeCompaction: CompactionStrategy = {
  compact: ({ instructions, compactNative }) => compactNative(instructions),
};
