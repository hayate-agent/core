// SPDX-License-Identifier: Apache-2.0
import type { ReviewState } from "./review.js";

/** Bounded transport/model projection. The authoritative history stays in the ledger. */
export function summarizeReview(state: ReviewState, evidencePath?: string): string {
  const last = state.rounds.at(-1);
  const findings = last?.findings ?? [];
  const ordered = [...findings].sort((a, b) => a.severity.localeCompare(b.severity));
  const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify({
    status: state.status,
    fingerprint: last?.fingerprint ? clip(last.fingerprint, 128) : undefined,
    rounds: state.rounds.length,
    blockers: findings.filter(f => (f.severity === "P0" || f.severity === "P1") &&
      !last?.assessment.some(a => a.id === f.id && a.disposition === "false-positive" && a.evidence.trim())).length,
    findings: ordered.slice(0, 8).map(f => ({ id: clip(f.id, 100), severity: f.severity,
      file: clip(f.file, 180), line: f.line, title: clip(f.title, 160), evidence: clip(f.evidence, 320),
      assessment: last?.assessment.find(a => a.id === f.id)?.disposition })),
    omittedFindings: Math.max(0, findings.length - 8),
    evidence: evidencePath ? clip(evidencePath, 512) : "Local review ledger; full history intentionally omitted.",
  });
}
