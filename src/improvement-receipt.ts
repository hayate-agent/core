export interface ImprovementDelivery {
  stream: "upstream" | "variant" | "instance";
  status: "local" | "pushed" | "integrated" | "deployed" | "blocked";
  repository?: string;
  branch?: string;
  commit?: string;
  pullRequest?: string;
  deployment?: string;
  blocker?: string;
}

export interface ExperimentReceipt {
  /** Omitted on legacy receipts: readable, but not evidence of new performed work. */
  execution?: "performed" | "pending";
  hypothesis: string;
  baseline: string;
  candidate: string;
  evidence: string;
  outcome: "improved" | "rejected" | "inconclusive";
  /** Reported delivery evidence, never a host-verified push/merge/deployment grant. */
  delivery?: ImprovementDelivery;
}
