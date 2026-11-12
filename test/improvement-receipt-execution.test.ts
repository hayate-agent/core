import test from "node:test";
import assert from "node:assert/strict";
import nightly from "../src/builtin-plugins/nightly-default.js";
import { experimentReceipts } from "../src/builtin-plugins/improvement-report.js";
import type { NightlyProgress } from "../src/nightly-strategy.js";

const legacy = { hypothesis: "measured candidate", baseline: "baseline measured", candidate: "change tried",
  evidence: "isolated test output", outcome: "inconclusive" };
const block = (value: unknown) => "```improvement-experiment\n" + JSON.stringify(value) + "\n```";
const state = (): NightlyProgress => ({ experiments: [], recentHypotheses: [], noExperimentTurns: 1, results: [] });

test("legacy receipts remain readable without being relabeled or counted as new work", () => {
  assert.deepEqual(experimentReceipts(block(legacy)), [legacy]);
  const s = state(); nightly.completed(s, block(legacy));
  assert.equal(s.experiments!.length, 0);
  assert.equal(s.noExperimentTurns, 2);
  assert.deepEqual(s.recentHypotheses, []);
});

test("pending receipt cannot reset productivity or consume a later performed hypothesis", () => {
  const s = state();
  nightly.completed(s, block({ ...legacy, execution: "pending" }));
  assert.equal(s.noExperimentTurns, 2);
  assert.equal(s.experiments!.length, 0);
  assert.deepEqual(s.recentHypotheses, []);
  nightly.completed(s, block({ ...legacy, execution: "performed" }));
  assert.equal(s.noExperimentTurns, 0);
  assert.equal(s.experiments!.length, 1);
  assert.equal(s.experiments![0]!.outcome, "inconclusive");
});

test("performed improved, rejected and inconclusive attempts count; malformed execution does not", () => {
  for (const outcome of ["improved", "rejected", "inconclusive"]) {
    const s = state();
    nightly.completed(s, block({ ...legacy, execution: "performed", outcome }));
    assert.equal(s.experiments!.length, 1, outcome);
    assert.equal(s.noExperimentTurns, 0, outcome);
  }
  for (const execution of [null, true, "complete", {}, 1])
    assert.deepEqual(experimentReceipts(block({ ...legacy, execution })), []);
});
