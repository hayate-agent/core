import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTaskIsolation, benchmarkRuns, parseBenchmarkSuite, suiteFingerprint } from "../src/benchmark/suite.js";

const base = () => ({
  name: "qwen-coder-levels",
  cases: [{
    id: "cache-reset",
    task: "Repariere den fehlerhaften Test in diesem Fixture-Verzeichnis.",
    model: "homelab/qwen3.8-27b-coder",
    thinking: "xhigh",
    fixtures: [{ path: "store.js", contents: "const cache = {};\n" }],
    acceptance: "node test.js",
    expectation: "ALL PASS",
  }],
});

test("suite parses with the documented default of three repeats", () => {
  const suite = parseBenchmarkSuite(base());
  assert.equal(suite.repeats, 3);
  assert.deepEqual(suite.cases[0].pin ?? { model: suite.cases[0].model, thinking: suite.cases[0].thinking }, { model: "homelab/qwen3.8-27b-coder", thinking: "xhigh" });
  assert.equal(suite.cases[0].fixtures[0].path, "store.js");
});

test("suite rejects unknown settings, duplicate ids and unusable pins", () => {
  assert.throws(() => parseBenchmarkSuite({ ...base(), capacity: 4 }), /unknown setting/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [base().cases[0], base().cases[0]] }), /Duplicate benchmark case id/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], thinking: "ultra" }] }), /Invalid worker pin thinking/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], model: "coder" }] }), /Invalid worker pin model ref/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), repeats: 0 }), /Invalid benchmark repeats/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [] }), /Invalid benchmark cases/);
});

test("fixture paths cannot escape the run directory", () => {
  for (const path of ["/etc/passwd", "../outside.js", "a/../../b.js", "~/x", "C:/Windows/x"])
    assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], fixtures: [{ path, contents: "" }] }] }),
      /must be relative|escapes the run directory/, path);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], fixtures: [{ path: "a.js", contents: "" }, { path: "a.js", contents: "x" }] }] }),
    /Duplicate benchmark fixture/);
});

test("schedule is serial per case and honours per-case repeats", () => {
  const suite = parseBenchmarkSuite({ ...base(), repeats: 2, cases: [
    { ...base().cases[0], id: "a" },
    { ...base().cases[0], id: "b", repeats: 3, thinking: "off" },
  ] });
  const runs = benchmarkRuns(suite);
  assert.equal(runs.length, 5);
  assert.deepEqual(runs.map(run => `${run.caseId}:${run.repeat}`), ["a:1", "a:2", "b:1", "b:2", "b:3"]);
  assert.deepEqual(runs[2].pin, { model: "homelab/qwen3.8-27b-coder", thinking: "off" });
});

test("fingerprint is stable for equal content and reacts to level and fixture changes", () => {
  const suite = parseBenchmarkSuite(base());
  const epoch = { revision: "abc", modelsMtime: 1 };
  assert.equal(suiteFingerprint(suite, epoch), suiteFingerprint(parseBenchmarkSuite(base()), epoch));
  assert.notEqual(suiteFingerprint(suite, epoch), suiteFingerprint(suite, { ...epoch, revision: "def" }));
  assert.notEqual(suiteFingerprint(suite, epoch), suiteFingerprint(parseBenchmarkSuite({
    ...base(), cases: [{ ...base().cases[0], thinking: "medium" }] }), epoch));
  assert.notEqual(suiteFingerprint(suite, epoch), suiteFingerprint(parseBenchmarkSuite({
    ...base(), cases: [{ ...base().cases[0], fixtures: [{ path: "store.js", contents: "const cache = { changed: true };\n" }] }] }), epoch));
});

test("a case may not carry its expectation inside the worker task text", () => {
  assert.doesNotThrow(() => assertTaskIsolation(parseBenchmarkSuite(base()).cases[0]));
  const leaked = parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], task: "Sorge dafuer, dass am Ende ALL PASS steht." }] });
  assert.throws(() => assertTaskIsolation(leaked.cases[0]), /leaks its expectation/);
});

test("deliverables and the reference solution have to be declared fixtures", () => {
  const ok = { ...base().cases[0], deliverables: ["store.js"], referenceSolution: [{ path: "store.js", contents: "fixed\n" }] };
  assert.doesNotThrow(() => parseBenchmarkSuite({ ...base(), cases: [ok] }));
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], deliverables: ["test.js"] }] }), /is not a fixture/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], deliverables: [] }] }), /Invalid benchmark deliverables/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], referenceSolution: [{ path: "fremd.js", contents: "x" }] }] }), /is not a fixture/);
  assert.throws(() => parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], referenceSolution: [{ path: "store.js", contents: "x", mode: 420 }] }] }), /unknown setting/);
});

test("the fingerprint covers the grading side, not only the task text", () => {
  const epoch = { revision: "abc" };
  const print = (patch: Record<string, unknown>) => suiteFingerprint(parseBenchmarkSuite({ ...base(), cases: [{ ...base().cases[0], ...patch }] }), epoch);
  const plain = print({});
  const reference = print({ referenceSolution: [{ path: "store.js", contents: "fix\n" }] });
  assert.notEqual(plain, print({ verifier: "node -e 1" }));
  assert.notEqual(plain, print({ deliverables: ["store.js"] }));
  assert.notEqual(plain, reference);
  assert.equal(reference, print({ referenceSolution: [{ path: "store.js", contents: "fix\n" }] }), "same content stays comparable");
  assert.notEqual(reference, print({ referenceSolution: [{ path: "store.js", contents: "anderer fix\n" }] }));
});

test("the hidden contract check stays out of the task while the acceptance may be named", () => {
  const leak = { ...base().cases[0], verifier: 'node -e "process.exit(0)"', task: 'Der Verifier prueft so: node -e "process.exit(0)"' };
  assert.throws(() => assertTaskIsolation(parseBenchmarkSuite({ ...base(), cases: [leak] }).cases[0]), /leaks its verifier/);
  const named = { ...base().cases[0], task: "Repariere store.js; das eingefrorene test.js muss danach durchlaufen." };
  assert.doesNotThrow(() => assertTaskIsolation(parseBenchmarkSuite({ ...base(), cases: [named] }).cases[0]),
    "naming the frozen test is how a coding task is stated");
});
