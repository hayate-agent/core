export interface ExperimentReceipt {
  hypothesis: string;
  baseline: string;
  candidate: string;
  evidence: string;
  outcome: "improved" | "rejected" | "inconclusive";
}
