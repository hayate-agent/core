import type { ExperimentReceipt } from "./improvement-receipt.js";
export type { ExperimentReceipt } from "./improvement-receipt.js";

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

/** Plain report text, not executable Markdown. Raw receipts remain in the archive. */
function reportText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s]+/gi, url => {
      try { const parsed = new URL(url); parsed.username = ""; parsed.password = ""; parsed.search = ""; parsed.hash = ""; return parsed.toString(); }
      catch { return "[Link entfernt]"; }
    })
    .replace(/\b(Bearer\s+)\S+/gi, "$1[entfernt]")
    .replace(/\b(api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+/gi, "$1=[entfernt]")
    .replace(/\b(?:sk-|ghp_|github_pat_|hvs\.)[A-Za-z0-9_.-]+/g, "[Zugangsdaten entfernt]")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/[`<>\[\]*_]/g, "")
    .replace(/\s+/g, " ").trim();
}

/** Render reported experiments, never turn transcripts or inferred deployment status. */
export function improvementReport(state: { night: string; turns: number; noExperimentTurns?: number }, timezone: string,
  receipts: ExperimentReceipt[], artifact: string): string {
  const counts = { improved: 0, rejected: 0, inconclusive: 0 };
  for (const receipt of receipts) counts[receipt.outcome]++;
  const lines = [`Nachtbericht ${reportText(state.night)} (${reportText(timezone)})`, `Arbeits-Turns: ${state.turns}.`,
    `Experimente: ${receipts.length}. Lokal als verbessert gemeldet: ${counts.improved}; verworfen: ${counts.rejected}; unentscheidbar: ${counts.inconclusive}.`,
    "Stand: lokale Versuchsergebnisse, keine unabhängige Freigabe. Ob ein Vorschlag veröffentlicht oder im Betrieb angekommen ist, muss separat geprüft werden.",
    "Ergebnisse und Nutzen"];
  if ((state.noExperimentTurns ?? 0) >= 3) lines.push("⚠️ Nachtlauf gestoppt: drei Turns ohne neues protokolliertes Experiment.");
  if (!receipts.length) lines.push("Keine abgeschlossenen Experimente protokolliert.");
  let included = 0;
  for (const receipt of receipts) {
    const status = { improved: "Lokal verbessert (Vorschlag)", rejected: "Verworfen", inconclusive: "Unentscheidbar – Klärung offen" }[receipt.outcome];
    const block = `\n${included + 1}. ${status}\nZiel / erwarteter Nutzen: ${reportText(receipt.hypothesis)}\nVorher: ${reportText(receipt.baseline)}\nAusprobiert / nachher: ${reportText(receipt.candidate)}\nBelege und offene Punkte: ${reportText(receipt.evidence)}`;
    if (lines.join("\n").length + block.length > 12000) break;
    lines.push(block); included++;
  }
  if (included < receipts.length) lines.push(`Weitere ${receipts.length - included} Experimente stehen in den lokalen Details; keine angeschnittenen Einträge.`);
  lines.push(`Details: vollständige strukturierte Belege im lokalen Artefakt ${reportText(artifact)}`);
  return lines.join("\n");
}
