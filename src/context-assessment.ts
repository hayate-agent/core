// SPDX-License-Identifier: Apache-2.0
export interface BoundaryEvidence {
  /** Advisory model cancellation only; never grants authority. */
  signal?: AbortSignal;
  phase: "before" | "after";
  incoming: string;
  recent: string;
  percent?: number;
  pressureSinceCompaction: boolean;
}
export type BoundaryAssessment = (evidence: BoundaryEvidence) => Promise<"compact" | "handover" | "keep" | "unknown">;
