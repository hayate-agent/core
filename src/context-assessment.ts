export interface BoundaryEvidence {
  phase: "before" | "after";
  incoming: string;
  recent: string;
  percent?: number;
  pressureSinceCompaction: boolean;
}
export type BoundaryAssessment = (evidence: BoundaryEvidence) => Promise<"compact" | "handover" | "keep" | "unknown">;
