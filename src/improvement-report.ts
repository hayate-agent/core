export interface ExperimentReceipt {
  hypothesis: string;
  baseline: string;
  candidate: string;
  evidence: string;
  outcome: "improved" | "rejected" | "inconclusive";
}

/** Parse only complete, validated receipts; raw model prose is never report markup. */
export function experimentReceipts(reply: string): ExperimentReceipt[] {
  const receipts: ExperimentReceipt[] = [];
  for (const match of reply.matchAll(/^```improvement-experiment[^\S\r\n]*\r?\n((?:(?!^```improvement-experiment)[\s\S])*?)^```[^\S\r\n]*\r?$/gm)) {
    try {
      const value = JSON.parse(match[1]!);
      if (!value || !["hypothesis", "baseline", "candidate", "evidence", "outcome"].every(key =>
        typeof value[key] === "string" && value[key].trim() && value[key].length <= 2000) ||
        !["improved", "rejected", "inconclusive"].includes(value.outcome)) continue;
      receipts.push({ hypothesis: value.hypothesis, baseline: value.baseline, candidate: value.candidate,
        evidence: value.evidence, outcome: value.outcome });
    } catch { /* Malformed receipts are not evidence. */ }
  }
  return receipts;
}

export function uniqueExperiments(receipts: ExperimentReceipt[]): ExperimentReceipt[] {
  const seen = new Set<string>();
  return receipts.filter(receipt => {
    const key = receipt.hypothesis.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

/** Whole receipts only: never slice JSON/fences or echo arbitrary turn responses. */
export function improvementReport(state: { night: string; turns: number; noExperimentTurns?: number }, timezone: string,
  receipts: ExperimentReceipt[], artifact: string): string {
  const counts = { improved: 0, rejected: 0, inconclusive: 0 };
  for (const receipt of receipts) counts[receipt.outcome]++;
  const lines = [`Nachtbericht ${state.night} (${timezone})`, `Arbeits-Turns: ${state.turns}.`,
    `Neue protokollierte Experimente: ${receipts.length}. Lokal als verbessert gemeldet: ${counts.improved}; verworfen: ${counts.rejected}; unentscheidbar: ${counts.inconclusive}.`,
    "Gemeldete Evidenz, keine unabhängige Freigabe. Evaluation, Review, Veröffentlichung und Aktivierung sind durch diese Belege nicht nachgewiesen.",
    `Vollständige strukturierte Belege (lokales Artefakt): ${artifact}`];
  if ((state.noExperimentTurns ?? 0) >= 3) lines.push("⚠️ Nachtlauf gestoppt: drei Turns ohne neues protokolliertes Experiment.");
  if (!receipts.length) lines.push("Keine abgeschlossenen Experimente protokolliert.");
  let included = 0;
  for (const receipt of receipts) {
    // JSON escaping prevents embedded backticks/newlines from becoming report fences.
    const json = JSON.stringify(receipt).replace(/`/g, "\\u0060");
    const block = `\n\n\`\`\`improvement-experiment\n${json}\n\`\`\``;
    if (lines.join("\n").length + block.length > 12000) break;
    lines.push(block); included++;
  }
  if (included < receipts.length) lines.push(`Weitere ${receipts.length - included} vollständige Belege stehen im lokalen Artefakt; keine angeschnittenen Einträge.`);
  lines.push("Merge ist kein Aktivierungsnachweis.");
  return lines.join("\n");
}
