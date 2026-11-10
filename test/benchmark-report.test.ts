import assert from "node:assert/strict";
import { test } from "node:test";
import type { BenchmarkRunOutcome, BenchmarkRunRecord } from "../src/benchmark/runner.js";
import type { WorkerMetrics } from "../src/benchmark/metrics.js";
import { renderBenchmarkReport, runCost, summarizeRecord } from "../src/benchmark/report.js";

const EPOCH = { revision: "abc123", version: "0.1.213", modelsFingerprint: "m1", settingsFingerprint: "s1" };

function attempt(over: Partial<WorkerMetrics> = {}): WorkerMetrics {
  return { model: "homelab/qwen3.8-27b-coder", thinkingLevel: "xhigh", assistantTurns: 1, inputTokens: 100, outputTokens: 100, reasoningChars: 100, durationMs: 1000, toolCalls: 1, ...over };
}

function outcome(over: Partial<BenchmarkRunOutcome> = {}): BenchmarkRunOutcome {
  return {
    caseId: "cache-reset", repeat: 1, taskId: "t", requestId: "r",
    pin: { model: "homelab/qwen3.8-27b-coder", thinking: "medium" }, status: "completed",
    wallMs: 2000, workspace: "/tmp/w", attempts: [attempt()], fixed: [], tampered: [], extra: [], pinMatches: true, verified: true, ...over,
  };
}

function record(id: string, outcomes: BenchmarkRunOutcome[], epoch = EPOCH): BenchmarkRunRecord {
  return { id, suite: "levels", fingerprint: "fp", epoch, startedAt: 1, finishedAt: 2, outcomes };
}

test("runCost adds up every attempt of a task, restarts included", () => {
  const cost = runCost(outcome({ attempts: [attempt({ assistantTurns: 3, outputTokens: 120, reasoningChars: 75, durationMs: 3003, toolCalls: 5 }), attempt({ assistantTurns: 1, outputTokens: 40, reasoningChars: 25, durationMs: 1000, toolCalls: 1 })] }));
  assert.equal(cost.attempts, 2);
  assert.deepEqual([cost.assistantTurns, cost.outputTokens, cost.reasoningChars, cost.durationMs, cost.toolCalls], [4, 160, 100, 4003, 6]);
  assert.equal(runCost(outcome({ attempts: [] })).attempts, 0);
});

test("a level is summarised with medians and p95 over its runs", () => {
  const levels = ["off", "medium", "xhigh"] as const;
  const outcomes = levels.flatMap(thinking => [1, 2, 3].map(repeat => outcome({
    repeat, pin: { model: "homelab/qwen3.8-27b-coder", thinking },
    attempts: [attempt({ thinkingLevel: thinking, assistantTurns: repeat, outputTokens: repeat * 100, reasoningChars: repeat * 1000, durationMs: repeat * 1000, toolCalls: repeat * 2 })],
  })));
  const summaries = summarizeRecord(record("r1", outcomes));
  assert.deepEqual(summaries.map(summary => summary.thinking), ["medium", "off", "xhigh"]);
  const off = summaries.find(summary => summary.thinking === "off")!;
  assert.deepEqual([off.runs, off.verified, off.attempts], [3, 3, 3]);
  assert.deepEqual([off.turnsMedian, off.outputTokensMedian, off.reasoningCharsMedian, off.toolCallsMedian], [2, 200, 2000, 4]);
  assert.deepEqual([off.modelTimeMedianMs, off.modelTimeP95Ms], [2000, 3000], "p95 of three runs is the slowest run");
  assert.deepEqual([off.wallMedianMs, off.wallP95Ms], [2000, 2000]);
});

test("a fixed deliverable counts, a tampered fixture does not, and neither is hidden", () => {
  const summaries = summarizeRecord(record("r2", [
    outcome({ verified: false, status: "timeout", attempts: [] }),
    outcome({ tampered: ["test.js"], verified: false }),
    outcome({ fixed: ["store.js"] }),
    outcome({ attempts: [attempt(), attempt()] }),
    outcome({ verified: false, diagnostic: "Pinned worker thinking level unsupported: xhigh" }),
  ]));
  assert.equal(summaries.length, 1);
  const summary = summaries[0]!;
  assert.deepEqual([summary.runs, summary.verified, summary.attempts], [5, 2, 5]);
  assert.deepEqual([summary.fixedRuns, summary.tamperedRuns, summary.timedOutRuns], [1, 1, 1]);
});

test("the report renders a table for runs of the current epoch", () => {
  const text = renderBenchmarkReport([record("r3", [
    outcome({ pin: { model: "homelab/qwen3.8-27b-coder", thinking: "off" } }),
    outcome({ repeat: 2, pin: { model: "homelab/qwen3.8-27b-coder", thinking: "xhigh" }, verified: false, acceptance: { command: "node test.js", exitCode: 1, outputTail: "1 failed" } }),
  ])], EPOCH);
  assert.match(text, /### levels — r3/);
  assert.match(text, /\| Level \| Runs \| OK \| Turns \|/);
  assert.match(text, /\|\s*off\s*\|/);
  assert.match(text, /xhigh/);
  assert.match(text, /Nicht verifiziert:/);
  assert.match(text, /cache-reset#2 \[xhigh\] completed acceptance:1/);
  assert.match(text, /cache-reset#1 \[off\]|off\s*\|/);
  assert.match(text, /models m1, settings s1/);
  assert.doesNotMatch(text, /nicht vergleichbar/);
});

test("a run from another configuration epoch is reported but never compared", () => {
  const stale = record("r4", [outcome()], { ...EPOCH, modelsFingerprint: "alter-wert" });
  const text = renderBenchmarkReport([record("r5", [outcome()], EPOCH), stale], EPOCH);
  assert.match(text, /r4.*nicht vergleichbar/s);
  assert.match(text, /modelsFingerprint/);
  assert.match(text, /### levels — r5/, "the current run is still reported");
  const onlyStale = renderBenchmarkReport([stale], EPOCH);
  assert.match(onlyStale, /kein Vergleich/);
  assert.doesNotMatch(onlyStale, /\| Level \|/);
});

test("empty input says so instead of rendering an empty table", () => {
  assert.equal(renderBenchmarkReport([], EPOCH), "Noch kein Benchmark-Lauf aufgezeichnet.");
  assert.equal(renderBenchmarkReport([record("r6", [], EPOCH)], EPOCH), "Noch kein Benchmark-Lauf aufgezeichnet.");
});
