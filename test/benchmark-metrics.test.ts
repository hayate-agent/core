import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WorkerMetrics } from "../src/benchmark/metrics.js";
import { locateWorkerSessionDirs, readWorkerMetrics, summarizeMetrics } from "../src/benchmark/metrics.js";

const zeroMetrics: WorkerMetrics = { model: "", thinkingLevel: "", assistantTurns: 0, inputTokens: 0, outputTokens: 0, reasoningChars: 0, durationMs: 0, toolCalls: 0 };

const assistantLine = (model: string, thinkingLevel: string, durationMs: number, usage: { input: number; output: number; total: number; totalTokens: number }, content: unknown[]): string =>
  JSON.stringify({ message: { role: "assistant", model, thinkingLevel, durationMs, usage, content } });

test("benchmark metrics locate, read and summarize worker session data", t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "benchmark-metrics-"));
  const sessions = path.join(base, "sessions");
  const dirA = path.join(sessions, "dispatch_task-1_aaa");
  const dirB = path.join(sessions, "dispatch_task-1_bbb");
  const decoy = path.join(sessions, "dispatch_other_zzz");
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.mkdirSync(decoy, { recursive: true });
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  fs.writeFileSync(path.join(dirA, "session-1.jsonl"), [
    JSON.stringify({ role: "user", content: "do the task" }),
    assistantLine("p/small", "low", 1200, { input: 100, output: 50, total: 150, totalTokens: 150 }, [
      { type: "thinking", thinking: "abc" },
      { type: "toolCall", name: "bash", arguments: { command: "ls" } },
    ]),
    assistantLine("p/small", "low", 3000, { input: 200, output: 100, total: 300, totalTokens: 300 }, [
      { type: "thinking", thinking: "defg" },
      { type: "toolCall", name: "read", arguments: { path: "x" } },
    ]),
    assistantLine("p/small", "low", 999, { input: 0, output: 0, total: 0, totalTokens: 0 }, []),
    "{kein json",
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(dirB, "session-2.jsonl"), [
    assistantLine("p/big", "high", 5000, { input: 400, output: 200, total: 600, totalTokens: 600 }, [
      { type: "thinking", thinking: "hijklmnop" },
      { type: "toolCall", name: "bash", arguments: { command: "pwd" } },
    ]),
    assistantLine("p/other", "medium", 1000, { input: 100, output: 50, total: 150, totalTokens: 150 }, []),
    JSON.stringify({ role: "user", content: "continue" }),
    "{kein json",
  ].join("\n") + "\n");

  fs.writeFileSync(path.join(decoy, "session-0.jsonl"), assistantLine("p/x", "off", 1, { input: 1, output: 1, total: 2, totalTokens: 2 }, []) + "\n");

  assert.deepEqual(locateWorkerSessionDirs(base, "task-1"), [dirA, dirB]);
  assert.deepEqual(locateWorkerSessionDirs(base, "other"), [decoy]);
  assert.deepEqual(locateWorkerSessionDirs(base, "missing"), []);
  assert.deepEqual(locateWorkerSessionDirs(path.join(base, "no-such-home"), "task-1"), []);

  assert.deepEqual(readWorkerMetrics(dirA), {
    model: "p/small", thinkingLevel: "low", assistantTurns: 2, inputTokens: 300, outputTokens: 150,
    reasoningChars: 7, durationMs: 4200, toolCalls: 2,
  });
  assert.deepEqual(readWorkerMetrics(dirB), {
    model: "p/big, p/other", thinkingLevel: "high, medium", assistantTurns: 2, inputTokens: 500, outputTokens: 250,
    reasoningChars: 9, durationMs: 6000, toolCalls: 1,
  });
  assert.deepEqual(readWorkerMetrics(path.join(sessions, "dispatch_task-1_missing")), zeroMetrics);

  const a = readWorkerMetrics(dirA);
  const b = readWorkerMetrics(dirB);
  assert.deepEqual(summarizeMetrics([a, b]), {
    runs: 2, assistantTurns: 4, inputTokens: 800, outputTokens: 400, reasoningChars: 16, toolCalls: 3,
    durationMs: { min: 4200, median: 5100, p95: 6000, max: 6000, total: 10200 },
    outputTokensMedian: 200,
  });
});

test("summarizeMetrics computes min, median, p95, max and total for edge sizes", () => {
  const run = (durationMs: number, outputTokens = 0): WorkerMetrics => ({ ...zeroMetrics, durationMs, outputTokens });
  assert.deepEqual(summarizeMetrics([]), {
    runs: 0, assistantTurns: 0, inputTokens: 0, outputTokens: 0, reasoningChars: 0, toolCalls: 0,
    durationMs: { min: 0, median: 0, p95: 0, max: 0, total: 0 }, outputTokensMedian: 0,
  });
  const odd = summarizeMetrics([100, 300, 200, 500, 400].map(run));
  assert.equal(odd.durationMs.min, 100);
  assert.equal(odd.durationMs.median, 300);
  assert.equal(odd.durationMs.p95, 500);
  assert.equal(odd.durationMs.max, 500);
  assert.equal(odd.durationMs.total, 1500);
  const even = summarizeMetrics([100, 200, 300, 400].map(run));
  assert.equal(even.durationMs.median, 250);
  assert.equal(even.durationMs.p95, 400);
  const twenty = summarizeMetrics(Array.from({ length: 20 }, (_, i) => run((i + 1) * 100, i + 1)));
  assert.equal(twenty.durationMs.p95, 1900);
  assert.equal(twenty.durationMs.median, 1050);
  assert.equal(twenty.outputTokensMedian, 10.5);
  assert.equal(twenty.durationMs.total, 21000);
});
