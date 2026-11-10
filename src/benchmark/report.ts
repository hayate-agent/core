import type { BenchmarkEpoch } from "./epoch.js";
import { epochDifferences } from "./epoch.js";
import type { BenchmarkRunOutcome, BenchmarkRunRecord } from "./runner.js";

/** Cost of one case run, summed over every worker attempt of its task. */
export interface BenchmarkRunCost {
  model: string;
  thinking: string;
  assistantTurns: number;
  inputTokens: number;
  outputTokens: number;
  reasoningChars: number;
  durationMs: number;
  toolCalls: number;
  attempts: number;
}

/** What one pinned pair cost, aggregated over its runs. */
export interface BenchmarkLevelSummary {
  model: string;
  thinking: string;
  runs: number;
  verified: number;
  /** Worker attempts including restarts: runs with more than one attempt cost extra that belongs to the level. */
  attempts: number;
  turnsMedian: number;
  outputTokensMedian: number;
  reasoningCharsMedian: number;
  toolCallsMedian: number;
  modelTimeMedianMs: number;
  modelTimeP95Ms: number;
  wallMedianMs: number;
  wallP95Ms: number;
  /** Runs where the worker changed its declared deliverable (expected for coding cases). */
  fixedRuns: number;
  /** Runs where the worker touched a frozen file - these never count as verified. */
  tamperedRuns: number;
  timedOutRuns: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function p95(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** Cost of one run: all attempts of its task added up, restarts included. */
export function runCost(outcome: BenchmarkRunOutcome): BenchmarkRunCost {
  const base = { model: outcome.pin.model, thinking: outcome.pin.thinking, assistantTurns: 0, inputTokens: 0, outputTokens: 0, reasoningChars: 0, durationMs: 0, toolCalls: 0, attempts: 0 };
  for (const attempt of outcome.attempts) {
    base.assistantTurns += attempt.assistantTurns;
    base.inputTokens += attempt.inputTokens;
    base.outputTokens += attempt.outputTokens;
    base.reasoningChars += attempt.reasoningChars;
    base.durationMs += attempt.durationMs;
    base.toolCalls += attempt.toolCalls;
    base.attempts++;
  }
  return base;
}

export function summarizeRecord(record: BenchmarkRunRecord): BenchmarkLevelSummary[] {
  const groups = new Map<string, BenchmarkRunOutcome[]>();
  for (const outcome of record.outcomes) {
    const key = `${outcome.pin.model}\u0000${outcome.pin.thinking}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(outcome);
  }
  return [...groups.values()].map(outcomes => {
    const costs = outcomes.map(runCost);
    const first = outcomes[0]!;
    return {
      model: first.pin.model, thinking: first.pin.thinking,
      runs: outcomes.length,
      verified: outcomes.filter(outcome => outcome.verified).length,
      attempts: costs.reduce((total, cost) => total + cost.attempts, 0),
      turnsMedian: median(costs.map(cost => cost.assistantTurns)),
      outputTokensMedian: median(costs.map(cost => cost.outputTokens)),
      reasoningCharsMedian: median(costs.map(cost => cost.reasoningChars)),
      toolCallsMedian: median(costs.map(cost => cost.toolCalls)),
      modelTimeMedianMs: median(costs.map(cost => cost.durationMs)),
      modelTimeP95Ms: p95(costs.map(cost => cost.durationMs)),
      wallMedianMs: median(outcomes.map(outcome => outcome.wallMs)),
      wallP95Ms: p95(outcomes.map(outcome => outcome.wallMs)),
      fixedRuns: outcomes.filter(outcome => outcome.fixed.length).length,
      tamperedRuns: outcomes.filter(outcome => outcome.tampered.length).length,
      timedOutRuns: outcomes.filter(outcome => outcome.status === "timeout").length,
    };
  }).sort((left, right) => left.model.localeCompare(right.model) || left.thinking.localeCompare(right.thinking));
}

function row(summary: BenchmarkLevelSummary): string {
  const flags = [
    summary.verified < summary.runs ? `unverifiziert:${summary.runs - summary.verified}` : "",
    summary.tamperedRuns ? `manipuliert:${summary.tamperedRuns}` : "",
    summary.timedOutRuns ? `timeout:${summary.timedOutRuns}` : "",
    summary.attempts > summary.runs ? `restarts:${summary.attempts - summary.runs}` : "",
  ].filter(Boolean).join(" ");
  return `| ${summary.thinking.padEnd(6)} | ${String(summary.runs).padStart(3)} | ${String(summary.verified).padStart(3)} `
    + `| ${String(summary.turnsMedian).padStart(4)} | ${String(summary.outputTokensMedian).padStart(7)} `
    + `| ${String(summary.reasoningCharsMedian).padStart(8)} | ${String(summary.modelTimeMedianMs).padStart(8)} `
    + `| ${String(summary.modelTimeP95Ms).padStart(8)} | ${String(summary.wallMedianMs).padStart(8)} | ${flags || "ok"} |`;
}

/**
 * Renders one run, or several runs side by side. Runs from a different
 * configuration epoch are reported but never ranked together: that is how a
 * comparison was produced here once that looked like a result and was not one.
 */
export function renderBenchmarkReport(records: BenchmarkRunRecord[], current?: BenchmarkEpoch): string {
  const usable = records.filter(record => record.outcomes.length);
  if (!usable.length) return "Noch kein Benchmark-Lauf aufgezeichnet.";
  const lines: string[] = [];
  const comparable: BenchmarkRunRecord[] = [];
  for (const record of usable) {
    const differences = current ? epochDifferences(record.epoch, current) : [];
    if (differences.length) {
      lines.push(`⚠️ ${record.suite} (${record.id}): nicht vergleichbar - Konfiguration geändert seit dem Lauf (${differences.join(", ")}).`);
      continue;
    }
    comparable.push(record);
  }
  if (!comparable.length) return `${lines.join("\n")}\n\nKein Lauf aus der aktuellen Konfiguration: kein Vergleich.`;
  if (lines.length) lines.push("");
  for (const record of comparable) {
    const summaries = summarizeRecord(record);
    const cases = new Set(record.outcomes.map(outcome => outcome.caseId));
    lines.push(`### ${record.suite} — ${record.id}`);
    lines.push(`Epoch ${record.epoch.revision}${record.epoch.version ? ` (${record.epoch.version})` : ""}, models ${record.epoch.modelsFingerprint}, settings ${record.epoch.settingsFingerprint}`);
    lines.push(`| Level | Runs | OK | Turns | Out-Tok | Denk-Zchn | Modell-ms | p95-ms | Wall-ms | Hinweis |`);
    lines.push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const summary of summaries) lines.push(row(summary));
    const unverified = record.outcomes.filter(outcome => !outcome.verified);
    if (unverified.length) {
      lines.push("");
      lines.push("Nicht verifiziert:");
      for (const outcome of unverified.slice(0, 10))
        lines.push(`- ${outcome.caseId}#${outcome.repeat} [${outcome.pin.thinking}] ${outcome.status}`
          + `${outcome.tampered.length ? ` tampered:${outcome.tampered.join(",")}` : ""}`
          + `${outcome.model && outcome.thinkingLevel ? ` gesehen:${outcome.model}/${outcome.thinkingLevel}` : ""}`
          + `${outcome.acceptance && outcome.acceptance.exitCode !== 0 ? ` acceptance:${outcome.acceptance.exitCode}` : ""}`
          + `${outcome.diagnostic ? ` ${outcome.diagnostic}` : ""}`);
      if (unverified.length > 10) lines.push(`- … und ${unverified.length - 10} weitere`);
    }
  }
  if (comparable.length > 1) {
    lines.push("");
    lines.push("Mehrere Läufe: gleiche Suite und gleiche Epoch, aber einzeln zu lesen - Mediane über Läufe hinweg vermischen Wiederholungen mit Suiteränderungen.");
  }
  const incomplete = comparable.filter(record => !record.finishedAt);
  if (incomplete.length) lines.push(`\nLäuft noch: ${incomplete.map(record => record.id).join(", ")}`);
  return lines.join("\n");
}
