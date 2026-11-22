// Regression: valid performed experiment receipts must survive dispatcher step compaction and be adopted once.
// Fixtures mirror the SHAPES of real artifacts (synthetic content). Parser validation is unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp as mkdtempRaw, mkdir, writeFile, readFile, rm, realpath } from "node:fs/promises";
const mkdtemp = async (p: string) => realpath(await mkdtempRaw(p)); // retainContext rejects symlinked dirs (macOS /var)
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "../src/improvement.js";
import nightlyDefault from "../src/builtin-plugins/nightly-default.js";
import { experimentReceipts } from "../src/builtin-plugins/improvement-report.js";
import { compactTaskReport, sliceKeepingReceipts } from "../src/context-artifacts.js";
import { stepStatus } from "../src/dispatcher-sequential.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import type { Execution } from "../src/execution.js";

const KEY = "improvement:nightly";
const s = (n: number, tag: string) => `${tag} `.padEnd(n, "x");
const fence = (v: unknown) => "```improvement-experiment\n" + JSON.stringify(v) + "\n```";

const artifact1 = { execution: "performed", hypothesis: s(520, "reset spacing"), baseline: s(452, "13/18"), candidate: s(372, "commit"), evidence: s(926, "targeted 22 pass"), outcome: "improved" };
const artifact2 = { schema: s(38, "schema"), execution: "performed", experiment: "2026-11-22-spaced-duration", hypothesis: s(268, "spaced duration"),
  baseline: { base: s(40, "sha"), typecheckExit: 0 }, candidate: { sha: s(40, "sha"), typecheckExit: 0 }, evidence: [s(122, "npm test")], outcome: "improved" };
const artifact3Delivery = { stream: s(38, "upstream (harness/core)"), status: s(122, "pushed; PR open, review pending"), repository: "harness/core",
  branch: "delivery/2026-11-22-turn4-approval-path-preview", commit: "a".repeat(40), pullRequest: { number: 758, url: "https://example.invalid/pulls/758" }, blocker: null, notDone: ["merge"] };

const proseStep = `## Step 1 ledger\n${"Ran targeted tests, wrote durable JSON.\n".repeat(150)}Experiment JSON: /scratch/night/improvement-experiment-2026-11-21.v2.json (execution performed, outcome improved)\nSTEP-STATUS: complete`;
const longStepWithValidFence = `## Step 3 experiment\n${"Measured baseline and candidate.\n".repeat(150)}${fence(artifact1)}\n${"Delivery follow-up notes.\n".repeat(60)}STEP-STATUS: complete`;

/** Same composition as dispatcher-sequential.ts finalResult (not exported). */
const finalResult = (steps: string[]) => `Sequenzieller Plan abgeschlossen (${steps.length} Schritte).\n\n${steps.map((r, i) => `## Schritt ${i + 1}/${steps.length}: medium\n${r}`).join("\n\n")}`.slice(0, 64000);

async function dispatcherStep(dir: string, report: string): Promise<string> {
  assert.equal(stepStatus(report), "complete");
  return sliceKeepingReceipts(await compactTaskReport(dir, report), 8000); // dispatcher-sequential.ts:730-732
}

async function adopt(t: any, result: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), "acct-repro-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "improvement"));
  await writeFile(path.join(home, "improvement/state.json"), JSON.stringify({ version: 1, night: "2026-11-21", turns: 6, results: [], experiments: [], recentHypotheses: [], noExperimentTurns: 0, done: false }));
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(() => harness.stop(1000));
  const task = { id: "child-1", parent: KEY, status: "completed", result, dependency: { taskId: "improvement:2026-11-21:2", original: "nightly", depth: 0 } } as Execution;
  const c = new ImprovementController(home, harness, "UTC", () => Date.parse("2026-11-22T10:00:00Z"), nightlyDefault, undefined, () => [task]);
  await c.delegatedResult(task.id); await c.delegatedResult(task.id);
  const st = JSON.parse(await readFile(path.join(home, "improvement/state.json"), "utf8"));
  return { experiments: st.experiments.length, adoptedIds: st.delegatedResults, results: st.results.length };
}

test("parser security unchanged: invalid shapes stay rejected", () => {
  assert.equal(experimentReceipts(fence(artifact1)).length, 1);
  assert.equal(experimentReceipts(fence(artifact2)).length, 0, "evidence array/object baseline rejected");
  assert.equal(experimentReceipts(proseStep).length, 0, "prose/path-only is not a receipt");
  assert.equal(experimentReceipts(fence({ ...artifact1, outcome: "great" })).length, 0);
  assert.equal(experimentReceipts(fence({ ...artifact1, delivery: artifact3Delivery }))[0]!.delivery, undefined);
});

test("long step report keeps its valid receipts verbatim through compaction and the 8000-char step slice", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-ctx-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const second = { ...artifact1, hypothesis: s(300, "second hypothesis") };
  const long = `## exp\n${"Measured.\n".repeat(400)}${fence(artifact1)}\n${"notes\n".repeat(300)}${fence(second)}\n${"tail\n".repeat(200)}STEP-STATUS: complete`;
  const stored = await dispatcherStep(dir, long);
  assert.ok(stored.length < long.length);
  assert.equal(experimentReceipts(stored).length, 2);
  assert.match(stored, /Complete original at/, "excerpt marker remains");
});

test("compaction adds nothing without receipts and never duplicates receipts already in the excerpt", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-ctx-")); t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal((await compactTaskReport(dir, proseStep)).includes("retained verbatim"), false);
  const small = { execution: "performed", hypothesis: "h", baseline: "b", candidate: "c", evidence: "e", outcome: "improved" };
  const early = `${fence(small)}\n${"x\n".repeat(5000)}`;
  const out = await compactTaskReport(dir, early);
  assert.equal(experimentReceipts(out).length, 1);
  assert.equal(out.includes("retained verbatim"), false);
});

test("END-TO-END: long worker report with valid performed receipt is adopted exactly once", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-ctx-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const result = finalResult([await dispatcherStep(dir, proseStep), await dispatcherStep(dir, longStepWithValidFence)]);
  assert.deepEqual(await adopt(t, result), { experiments: 1, adoptedIds: ["child-1"], results: 1 }); // adopt() delivers twice
});

test("END-TO-END: invalid/prose-only results still adopt zero experiments (no invented values)", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-ctx-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const r = await adopt(t, finalResult([await dispatcherStep(dir, proseStep), await dispatcherStep(dir, `ok\n${fence(artifact2)}\nSTEP-STATUS: complete`)]));
  assert.equal(r.experiments, 0);
  assert.deepEqual(r.adoptedIds, ["child-1"]);
});

// Parser caps each field at 2000 chars with no total cap: a valid receipt can be ~10k chars (> old 5000 budget, > 8000 step limit).
const oversized = { execution: "performed", hypothesis: s(2000, "h"), baseline: s(2000, "b"), candidate: s(2000, "c"), evidence: s(2000, "e"), outcome: "improved" };

test("oversized parser-valid receipt (>5000 and >8000 chars) survives compaction and the step slice", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-ctx-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const report = `## Step\n${"Measured.\n".repeat(400)}${fence(oversized)}\n${"Notes.\n".repeat(400)}\nSTEP-STATUS: complete`;
  assert.ok(fence(oversized).length > 8000);
  assert.equal(experimentReceipts(report).length, 1);
  const out = await dispatcherStep(dir, report);
  assert.equal(experimentReceipts(out).length, 1);
  assert.deepEqual(experimentReceipts(out)[0], experimentReceipts(report)[0]);
});

test("END-TO-END: oversized valid receipt is adopted exactly once; invalid oversized stays rejected", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "acct-ctx-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const mk = (r: unknown) => `## Step\n${"Measured.\n".repeat(400)}${fence(r)}\n${"Notes.\n".repeat(400)}\nSTEP-STATUS: complete`;
  const ok = finalResult([await dispatcherStep(dir, proseStep), await dispatcherStep(dir, mk(oversized))]);
  assert.deepEqual(await adopt(t, ok), { experiments: 1, adoptedIds: ["child-1"], results: 1 });
  const bad = finalResult([await dispatcherStep(dir, mk({ ...oversized, evidence: s(2001, "e") }))]);
  assert.equal((await adopt(t, bad)).experiments, 0); // parser limit unchanged
});

test("sliceKeepingReceipts: short text and receipt-free text behave like plain slice; no half fences", () => {
  assert.equal(sliceKeepingReceipts("abc", 10), "abc");
  const plain = "p".repeat(9000);
  assert.equal(sliceKeepingReceipts(plain, 8000), plain.slice(0, 8000));
  const out = sliceKeepingReceipts("p".repeat(7900) + "\n" + fence(artifact1) + "\ntail", 8000);
  assert.equal(experimentReceipts(out).length, 1);
});
