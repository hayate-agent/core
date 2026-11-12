export interface ExperimentReceipt {
  /** Omitted on legacy receipts: readable, but not evidence of new performed work. */
  execution?: "performed" | "pending";
  hypothesis: string;
  baseline: string;
  candidate: string;
  evidence: string;
  outcome: "improved" | "rejected" | "inconclusive";
}
