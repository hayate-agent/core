// SPDX-License-Identifier: Apache-2.0
export interface ExperimentReceipt {
  hypothesis: string;
  baseline: string;
  candidate: string;
  evidence: string;
  outcome: "improved" | "rejected" | "inconclusive";
}
