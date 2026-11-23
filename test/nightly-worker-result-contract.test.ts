import { test } from "node:test";
import assert from "node:assert/strict";
import { delegatedResultContract } from "../src/dispatcher-step-prompt.js";
import { experimentReceipts } from "../src/builtin-plugins/improvement-report.js";

test("nightly delegates receive a parseable receipt schema without changing completion authority", () => {
  const prompt = delegatedResultContract("improvement:nightly");
  assert.match(prompt, /```improvement-experiment\n/);
  assert.match(prompt, /not only in a scratch file/);
  assert.match(prompt, /delivery hold/);
  assert.match(prompt, /STEP-STATUS/);
  assert.match(prompt, /Never fabricate measurements/);
  assert.match(prompt, /delivery alone is not a new experiment/);
  const example = prompt.match(/```improvement-experiment\n([\s\S]*?)\n```/)![1];
  // The example lists allowed outcomes; actual output must choose one.
  const receipt = JSON.parse(example);
  receipt.outcome = "inconclusive";
  const text = "```improvement-experiment\n" + JSON.stringify(receipt) + "\n```";
  assert.equal(experimentReceipts(text).length, 1);
  receipt.execution = "invented";
  assert.equal(experimentReceipts("```improvement-experiment\n" + JSON.stringify(receipt) + "\n```").length, 0);
});

test("ordinary and lookalike parents do not receive the nightly contract", () => {
  for (const parent of ["matrix:room", "dispatch:improvement:nightly", "improvement:2026-11-22:1", "improvement:nightly-extra", ""]) {
    assert.equal(delegatedResultContract(parent), "");
  }
});
