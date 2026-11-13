import type { ExperimentReceipt as CoreExperimentReceipt } from "./improvement-receipt.js";
/** Optional extension remains readable with older Core contracts. */
export type ExperimentReceipt = CoreExperimentReceipt & { delivery?: {
  stream: "upstream" | "instance";
  status: "local" | "pushed" | "integrated" | "deployed" | "blocked";
  repository?: string; branch?: string; commit?: string; pullRequest?: string;
  deployment?: string; blocker?: string;
} };

function deliveryReceipt(value: unknown): ExperimentReceipt["delivery"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const d = value as Record<string, unknown>;
  if (!['upstream', 'instance'].includes(String(d.stream)) ||
      !['local', 'pushed', 'integrated', 'deployed', 'blocked'].includes(String(d.status)) ||
      (d.repository === undefined ? d.status !== 'blocked' : typeof d.repository !== 'string' || !d.repository.trim() || d.repository.length > 2000) ||
      Object.keys(d).some(key => !['stream', 'status', 'repository', 'branch', 'commit', 'pullRequest', 'deployment', 'blocker'].includes(key))) return undefined;
  for (const key of ['branch', 'commit', 'pullRequest', 'deployment', 'blocker'])
    if (d[key] !== undefined && (typeof d[key] !== 'string' || !(d[key] as string).trim() || (d[key] as string).length > 2000)) return undefined;
  const safeRemote = (value: string, ssh = false) => {
    if (ssh && /^git@[a-zA-Z0-9.-]+:[a-zA-Z0-9_./-]+$/.test(value)) return true;
    try { const u = new URL(value); return (u.protocol === 'https:' || ssh && u.protocol === 'ssh:') &&
      !u.password && (!u.username || ssh && u.protocol === 'ssh:' && u.username === 'git') && !u.search && !u.hash; }
    catch { return false; }
  };
  if (d.repository !== undefined && !safeRemote(d.repository as string, true) || d.pullRequest && !safeRemote(d.pullRequest as string)) return undefined;
  if (d.branch !== undefined && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(d.branch as string) || (d.branch as string).includes('..'))) return undefined;
  if (d.commit !== undefined && !/^[a-f0-9]{40}$/.test(d.commit as string)) return undefined;
  if (['pushed', 'integrated', 'deployed'].includes(d.status as string) && (!d.commit || !d.branch)) return undefined;
  if (d.status === 'blocked' && !d.blocker || d.status === 'deployed' && !d.deployment) return undefined;
  return { ...d } as unknown as NonNullable<ExperimentReceipt['delivery']>;
}

/** False means delivery still requires work, not permission to exceed a window. */
export function deliveryPending(receipt: ExperimentReceipt): boolean {
  return receipt.outcome === 'improved' && (!receipt.delivery || receipt.delivery.status === 'local');
}

/** Parse only complete, validated receipts; raw model prose is never report markup. */
export function experimentReceipts(reply: string): ExperimentReceipt[] {
  const receipts: ExperimentReceipt[] = [];
  for (const match of reply.matchAll(/^```improvement-experiment[^\S\r\n]*\r?\n((?:(?!^```improvement-experiment)[\s\S])*?)^```[^\S\r\n]*\r?$/gm)) {
    try {
      const value = JSON.parse(match[1]!);
      if (!value || !["hypothesis", "baseline", "candidate", "evidence", "outcome"].every(key =>
        typeof value[key] === "string" && value[key].trim() && value[key].length <= 2000) ||
        !["improved", "rejected", "inconclusive"].includes(value.outcome) ||
        (value.execution !== undefined && !["performed", "pending"].includes(value.execution))) continue;
      const delivery = deliveryReceipt(value.delivery);
      // Invalid delivery claims cannot turn a local experiment into a shipped one.
      receipts.push({ hypothesis: value.hypothesis, baseline: value.baseline, candidate: value.candidate,
        evidence: value.evidence, outcome: value.outcome,
        ...(value.execution !== undefined ? { execution: value.execution } : {}),
        ...(delivery ? { delivery } : {}) });
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
export function improvementReport(state: { night: string; turns: number; noExperimentTurns?: number; deliveryBacklog?: ExperimentReceipt[] }, timezone: string,
  receipts: ExperimentReceipt[], artifact: string): string {
  const counts = { improved: 0, rejected: 0, inconclusive: 0 };
  for (const receipt of receipts) counts[receipt.outcome]++;
  const lines = [`Nachtbericht ${reportText(state.night)} (${reportText(timezone)})`, `Arbeits-Turns: ${state.turns}.`,
    `Experimente: ${receipts.length}. Lokal als verbessert gemeldet: ${counts.improved}; verworfen: ${counts.rejected}; unentscheidbar: ${counts.inconclusive}.`,
    "Stand: gemeldete Versuchs- und Auslieferungsbelege, keine unabhängige Freigabe. Push, Integration und tatsächliche Aktivierung sind getrennte Stände.",
    `Auslieferung: ${receipts.filter(deliveryPending).length} verbessert, aber noch ohne Remote-Übergabe; ${receipts.filter(r => r.delivery?.status === 'blocked').length} konkret blockiert. Fehlende Alt-Belege bedeuten unbekannt, nicht nachgewiesen unveröffentlicht.`, 
    "Ergebnisse und Nutzen"];
  if (state.deliveryBacklog?.length) {
    lines.push(`Übernommene Auslieferungsfälle: ${state.deliveryBacklog.length} (keine neuen Experimente dieser Nacht).`);
    for (const receipt of state.deliveryBacklog.slice(0, 8)) {
      const d = receipt.delivery;
      lines.push(`Auslieferung Altbestand: ${reportText(receipt.hypothesis).slice(0, 160)}; ${d ? reportText(d.stream + '/' + d.status) + '; ' + reportText(d.repository ?? 'Ziel ungeklärt').slice(0, 180) + (d.commit ? '; ' + reportText(d.commit) : '') + (d.blocker ? '; Blocker: ' + reportText(d.blocker).slice(0, 220) : '') : 'Remote-Übergabe/Bereitstellung unbelegt'}`);
    }
  }
  if ((state.noExperimentTurns ?? 0) >= 3) lines.push("⚠️ Nachtlauf gestoppt: drei Turns ohne neues protokolliertes Experiment.");
  if (!receipts.length) lines.push("Keine abgeschlossenen Experimente protokolliert.");
  let included = 0;
  for (const receipt of receipts) {
    const status = { improved: "Lokal verbessert (Vorschlag)", rejected: "Verworfen", inconclusive: "Unentscheidbar – Klärung offen" }[receipt.outcome];
    const delivery = receipt.delivery;
    const handoff = delivery ? `\nAuslieferung (gemeldet): ${reportText(delivery.stream)} / ${reportText(delivery.status)}; Repo: ${reportText(delivery.repository ?? 'Ziel ungeklärt')}${delivery.branch ? '; Branch: ' + reportText(delivery.branch) : ''}${delivery.commit ? '; Commit: ' + reportText(delivery.commit) : ''}${delivery.pullRequest ? '; PR: ' + reportText(delivery.pullRequest) : ''}${delivery.deployment ? '; Aktivierungsbeleg: ' + reportText(delivery.deployment) : ''}${delivery.blocker ? '; Blocker: ' + reportText(delivery.blocker) : ''}` : receipt.outcome === 'improved' ? '\nAuslieferung: Remote-Übergabe und Bereitstellung unbelegt; offen, nicht als ausgeliefert zählen.' : '';
    const block = `\n${included + 1}. ${status}\nZiel / erwarteter Nutzen: ${reportText(receipt.hypothesis)}\nVorher: ${reportText(receipt.baseline)}\nAusprobiert / nachher: ${reportText(receipt.candidate)}\nBelege und offene Punkte: ${reportText(receipt.evidence)}${handoff}`;
    if (lines.join("\n").length + block.length > 12000) break;
    lines.push(block); included++;
  }
  if (included < receipts.length) lines.push(`Weitere ${receipts.length - included} Experimente stehen in den lokalen Details; keine angeschnittenen Einträge.`);
  lines.push(`Details: vollständige strukturierte Belege im lokalen Artefakt ${reportText(artifact)}`);
  return lines.join("\n");
}
