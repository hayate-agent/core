import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Execution } from "../src/execution.js";
import { BenchmarkRunner, type BenchmarkSubmitter } from "../src/benchmark/runner.js";
import { benchmarkEpoch } from "../src/benchmark/epoch.js";
import { parseBenchmarkSuite, suiteFingerprint } from "../src/benchmark/suite.js";

class FakeDispatcher implements BenchmarkSubmitter {
  submissions: { parent: string; requestId: string; input: string; pinned?: unknown }[] = [];
  cancellations: string[] = [];
  statuses = new Map<string, ExecutionStatus>();
  results = new Map<string, string>();
  hang = false;
  rejectWith?: string;
  onWait?: (taskId: string, workspace: string) => Promise<void>;
  private counter = 0;
  private lastWorkspace = "";
  constructor() { }
  async submitScheduled(parent: string, requestId: string, input: string, _mandate: unknown, pinned?: unknown) {
    if (this.rejectWith) throw Error(this.rejectWith);
    const id = `task-${++this.counter}`;
    this.submissions.push({ parent, requestId, input, pinned });
    this.lastWorkspace = input.split("Arbeitsverzeichnis: ")[1]!.split("\n")[0]!;
    this.statuses.set(id, "completed");
    this.results.set(id, "fertich");
    return { id };
  }
  async waitForExecution(id: string) {
    await this.onWait?.(id, this.lastWorkspace);
    if (this.hang) await new Promise(() => { });
  }
  async control(_parent: string, id: string, action: string) { if (action === "cancel") this.cancellations.push(id); }
  list(): Execution[] {
    return [...this.statuses].map(([id, status]) => ({ id, status, result: this.results.get(id) }) as Execution);
  }
}

type ExecutionStatus = "ready" | "running" | "paused" | "blocked" | "completed" | "cancelled" | "failed";

/**
 * Fake shell that stays faithful to the fixture: the untouched case is broken, so the
 * preflight has to see a failing contract check, while a finished worker run passes.
 */
function passingShell(output = "ALL PASS") {
  return async (_command: string, cwd: string) => ({
    exitCode: cwd.includes(`${path.sep}preflight${path.sep}`) ? 1 : 0,
    output,
  });
}

const suiteSource = () => ({
  name: "levels",
  repeats: 2,
  cases: [{
    id: "cache-reset",
    task: "Bring den Test in diesem Verzeichnis zum Laufen, ohne ihn zu verändern.",
    model: "homelab/qwen3.8-27b-coder",
    thinking: "xhigh",
    fixtures: [{ path: "store.js", contents: "const cache = {};\n" }, { path: "test.js", contents: "if (1) throw 0;\n" }],
    acceptance: "node test.js",
    expectation: "ALL PASS",
  }],
});

async function environment() {
  const base = await mkdtemp(path.join(os.tmpdir(), "benchmark-runner-"));
  const home = path.join(base, "home");
  const dir = path.join(base, "state");
  await mkdir(home, { recursive: true });
  return { base, home, dir, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** A worker session log shaped exactly like the real dispatch_* directories. */
async function seedSession(home: string, taskId: string, attempt: string, turns = 1, level = "xhigh") {
  const dir = path.join(home, "sessions", `dispatch_${taskId}_${attempt}`);
  await mkdir(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", cwd: "/tmp", version: 1 })];
  for (let index = 0; index < turns; index++)
    lines.push(JSON.stringify({
      type: "message", timestamp: 1_700_000_000_000 + index,
      message: {
        role: "assistant", model: "qwen3.8-27b-coder", thinkingLevel: level, durationMs: 1_000 + index,
        usage: { input: 100, output: 40, totalTokens: 140 },
        content: [{ type: "thinking", thinking: "x".repeat(25) }, { type: "toolCall", name: "bash" }],
      },
    }));
  await writeFile(path.join(dir, "2026-11-09T00-00-00-000Z_session.jsonl"), lines.join("\n") + "\n");
  return dir;
}

test("a suite run pins each submission, keeps the answer key out of the task and records metrics", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    dispatcher.onWait = async taskId => { await seedSession(env.home, taskId, "a1"); };
    const runner = new BenchmarkRunner(dispatcher, {
      home: env.home, parent: "matrix:test", dir: env.dir, caseTimeoutMs: 5_000,
      now: () => 1_700_000_000_000, execute: passingShell(),
    });
    const suite = parseBenchmarkSuite(suiteSource());
    const epoch = await benchmarkEpoch(env.home);
    const progress: string[] = [];
    const record = await runner.run(suite, suiteFingerprint(suite, {}), epoch, outcome => progress.push(`${outcome.caseId}:${outcome.repeat}:${outcome.status}`));

    assert.equal(dispatcher.submissions.length, 2, "two repeats of one case");
    assert.deepEqual([...new Set(dispatcher.submissions.map(s => s.requestId))].length, 2);
    assert.deepEqual(dispatcher.submissions[0]!.pinned, { model: "homelab/qwen3.8-27b-coder", thinking: "xhigh" });
    assert.equal(dispatcher.submissions[0]!.parent, "matrix:test");
    assert.ok(!dispatcher.submissions[0]!.input.includes("ALL PASS"), "expectation must not reach the worker");
    assert.match(dispatcher.submissions[0]!.input, /Arbeitsverzeichnis: /);

    const written = await readFile(path.join(record.outcomes[0]!.workspace, "store.js"), "utf8");
    assert.equal(written, "const cache = {};\n");

    assert.equal(record.outcomes.length, 2);
    assert.equal(record.outcomes[0]!.verified, true);
    assert.equal(record.outcomes[0]!.acceptance?.exitCode, 0);
    assert.deepEqual([record.outcomes[0]!.fixed, record.outcomes[0]!.tampered, record.outcomes[0]!.extra], [[], [], []]);
    assert.equal(record.outcomes[0]!.pinMatches, true, "observed model and level match the pin");
    assert.equal(record.outcomes[0]!.attempts.length, 1, "the worker session is read back");
    assert.deepEqual(progress, ["cache-reset:1:completed", "cache-reset:2:completed"]);
    assert.equal(record.epoch.settingsFingerprint, epoch.settingsFingerprint);
    const persisted = JSON.parse(await readFile(path.join(env.dir, record.id, "record.json"), "utf8")) as { outcomes: unknown[]; fingerprint: string };
    assert.equal(persisted.outcomes.length, 2);
    assert.equal(persisted.fingerprint, suiteFingerprint(suite, {}));
  } finally { await env.cleanup(); }
});

test("worker metrics are collected per attempt, including a restarted worker", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    dispatcher.onWait = async (taskId, workspace) => {
      await seedSession(env.home, taskId, "aaaa", 3);
      await seedSession(env.home, taskId, "bbbb", 1);
      await writeFile(path.join(workspace, "side-effect.log"), "der worker hat geschrieben\n");
    };
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 5_000, now: () => 1, execute: passingShell("") });
    const record = await runner.run(parseBenchmarkSuite({ ...suiteSource(), repeats: 1 }), "fp", await benchmarkEpoch(env.home));
    const outcome = record.outcomes[0]!;
    assert.equal(outcome.attempts.length, 2, "one directory per worker attempt");
    assert.deepEqual(outcome.attempts.map(attempt => attempt.assistantTurns), [3, 1]);
    assert.deepEqual(outcome.attempts.map(attempt => attempt.outputTokens), [120, 40]);
    assert.deepEqual(outcome.attempts.map(attempt => attempt.reasoningChars), [75, 25]);
    assert.deepEqual(outcome.attempts.map(attempt => attempt.durationMs), [3003, 1000]);
    assert.deepEqual(outcome.attempts.map(attempt => attempt.model), ["qwen3.8-27b-coder", "qwen3.8-27b-coder"]);
    assert.equal(outcome.wallMs, 0);
  } finally { await env.cleanup(); }
});

test("fixture drift is never silently accepted", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    dispatcher.onWait = async (_taskId, workspace) => { await writeFile(path.join(workspace, "test.js"), "if (0) {}\n"); };
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 5_000, execute: passingShell() });
    const record = await runner.run(parseBenchmarkSuite(suiteSource()), "fp", await benchmarkEpoch(env.home));
    assert.deepEqual(record.outcomes.map(outcome => outcome.tampered), [["test.js"], ["test.js"]]);
    assert.deepEqual(record.outcomes.map(outcome => outcome.fixed), [[], []]);
    assert.equal(record.outcomes[0]!.verified, false, "a worker that rewrites the test did not pass");
  } finally { await env.cleanup(); }
});

test("a failing acceptance command keeps its exit code and output", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 5_000, execute: async () => ({ exitCode: 1, output: "1 test failed\n".repeat(200) }) });
    const record = await runner.run(parseBenchmarkSuite(suiteSource()), "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.acceptance?.exitCode, 1);
    assert.equal(record.outcomes[0]!.verified, false);
    assert.ok(record.outcomes[0]!.acceptance!.outputTail.length <= 1_001);
    assert.match(record.outcomes[0]!.acceptance!.outputTail, /1 test failed/);
  } finally { await env.cleanup(); }
});

test("a run that exceeds its budget is cancelled and marked as timeout", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    dispatcher.hang = true;
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 40, execute: passingShell("") });
    const record = await runner.run(parseBenchmarkSuite({ ...suiteSource(), repeats: 1 }), "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.status, "timeout");
    assert.equal(record.outcomes[0]!.verified, false);
    assert.deepEqual(dispatcher.cancellations, [record.outcomes[0]!.taskId]);
  } finally { await env.cleanup(); }
});

test("a strict pin rejection fails the run instead of measuring another model", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    dispatcher.rejectWith = "Pinned worker thinking level unsupported: xhigh";
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 5_000, execute: passingShell("") });
    const record = await runner.run(parseBenchmarkSuite(suiteSource()), "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.verified, false);
    assert.equal(record.outcomes[0]!.taskId, "", "nothing was submitted for a pin that cannot be honoured");
    assert.match(record.outcomes[0]!.diagnostic ?? "", /thinking level unsupported/);
    assert.equal(record.outcomes.length, 2, "the suite continues with the next repeat and still persists");
  } finally { await env.cleanup(); }
});

const BROKEN_STORE = `class A {
  #m = new Map();
  add(k, n) { const e = this.#m.get(k) || { n: 0 }; e.n += n; this.#m.set(k, e); return e.n; }
  count(k) { return this.#m.get(k)?.n ?? 0; }
  total() { let t = 0; for (const e of this.#m.values()) t += e.n; return t; }
  reset() { for (const k of this.#m.keys()) this.#m.set(k, {}); }
  merge(o) { for (const [k, e] of o.entries()) this.#m.set(k, { n: e.n }); }
  entries() { return [...this.#m.entries()]; }
}
module.exports = { A };
`;
const FIXED_STORE = BROKEN_STORE.replace(
  "reset() { for (const k of this.#m.keys()) this.#m.set(k, {}); }", "reset() { this.#m.clear(); }");
const CONTRACT_TEST = `const a = require("node:assert/strict");
const { A } = require("./store.js");
const x = new A();
x.add("k", 2); x.add("j", 3);
x.reset();
a.equal(x.total(), 0);
a.equal(x.count("k"), 0);
console.log("ALL PASS");
`;
/** Real shell, private contract check: the case the campaign had to teach me. */
const codingSuite = (store: string, over: Record<string, unknown> = {}) => parseBenchmarkSuite({
  name: "coding", repeats: 1,
  cases: [{
    id: "fix-reset",
    task: "Eine der Operationen in store.js ist fehlerhaft. Finde sie und behebe die Ursache; node test.js muss ALL PASS ausgeben.",
    model: "homelab/qwen3.8-27b-coder", thinking: "xhigh",
    fixtures: [{ path: "store.js", contents: store }, { path: "test.js", contents: CONTRACT_TEST }],
    deliverables: ["store.js"],
    acceptance: "node test.js",
    verifier: "node -e \"const s=require('fs').readFileSync('{workspace}/store.js','utf8');process.exit(s.includes('this.#m.clear()')?0:3)\"",
    referenceSolution: [{ path: "store.js", contents: FIXED_STORE }],
    ...over,
  }],
});

test("a coding case is verified by fixing its deliverable and passing the private verifier", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    dispatcher.onWait = async (taskId, workspace) => { await writeFile(path.join(workspace, "store.js"), FIXED_STORE); await seedSession(env.home, taskId, "a1"); };
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 30_000 });
    const record = await runner.run(codingSuite(BROKEN_STORE), "fp", await benchmarkEpoch(env.home));
    const outcome = record.outcomes[0]!;
    assert.equal(outcome.preflight?.status, "ok");
    assert.deepEqual([outcome.fixed, outcome.tampered, outcome.extra], [["store.js"], [], []]);
    assert.equal(outcome.acceptance?.exitCode, 0);
    assert.equal(outcome.verifier?.exitCode, 0, "the contract check grades the deliverable");
    assert.equal(outcome.verified, true);
    assert.ok(!dispatcher.submissions[0]!.input.includes(path.join(env.dir, record.id, "verify")),
      "the worker never learns where the contract check lives");
  } finally { await env.cleanup(); }
});

test("a case that is already solved never reaches a worker", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 30_000 });
    const record = await runner.run(codingSuite(FIXED_STORE), "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.status, "preflight-failed");
    assert.match(record.outcomes[0]!.diagnostic ?? "", /bereits gelöst/);
    assert.equal(dispatcher.submissions.length, 0, "no worker time is spent on a case that measures nothing");
  } finally { await env.cleanup(); }
});

test("a reference solution that does not solve the case is caught by the preflight", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 30_000 });
    const record = await runner.run(codingSuite(BROKEN_STORE, { referenceSolution: [{ path: "store.js", contents: BROKEN_STORE }] }), "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.status, "preflight-failed");
    assert.match(record.outcomes[0]!.diagnostic ?? "", /Referenzlösung besteht acceptance nicht/);
    assert.equal(dispatcher.submissions.length, 0);
  } finally { await env.cleanup(); }
});

test("a verifier the reference solution cannot satisfy invalidates the case", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    const runner = new BenchmarkRunner(dispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 30_000 });
    const impossible = codingSuite(BROKEN_STORE, { verifier: "node -e \"process.exit(7)\"" });
    const record = await runner.run(impossible, "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.status, "preflight-failed");
    assert.match(record.outcomes[0]!.diagnostic ?? "", /Verifier nicht/);
  } finally { await env.cleanup(); }
});

test("added files are reported without disqualifying, a foreign thinking level does", async () => {
  const env = await environment();
  try {
    const extraDispatcher = new FakeDispatcher();
    extraDispatcher.onWait = async (taskId, workspace) => {
      await writeFile(path.join(workspace, "store.js"), FIXED_STORE);
      await writeFile(path.join(workspace, "helper.js"), "// Hilfsdatei\n");
      await seedSession(env.home, taskId, "a1");
    };
    const runner = new BenchmarkRunner(extraDispatcher, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 30_000 });
    const record = await runner.run(codingSuite(BROKEN_STORE), "fp", await benchmarkEpoch(env.home));
    assert.deepEqual(record.outcomes[0]!.extra, ["helper.js"]);
    assert.equal(record.outcomes[0]!.verified, true, "acceptance and verifier decide, not file count");

    const wrongLevel = new FakeDispatcher();
    wrongLevel.onWait = async (taskId, workspace) => {
      await writeFile(path.join(workspace, "store.js"), FIXED_STORE);
      await seedSession(env.home, taskId, "b1", 1, "medium");
    };
    const second = await new BenchmarkRunner(wrongLevel, { home: env.home, parent: "p", dir: env.dir, caseTimeoutMs: 30_000 })
      .run(codingSuite(BROKEN_STORE), "fp2", await benchmarkEpoch(env.home));
    assert.equal(second.outcomes[0]!.pinMatches, false);
    assert.equal(second.outcomes[0]!.verified, false, "a run at another level proves nothing about this level");
    assert.match(second.outcomes[0]!.diagnostic ?? "", /Pin-Abgleich/);
  } finally { await env.cleanup(); }
});

/** All files below a directory, recursively. */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await tree(target));
    else files.push(target);
  }
  return files;
}

test("preflight material never appears inside the run tree while a worker runs", async () => {
  const env = await environment();
  try {
    const dispatcher = new FakeDispatcher();
    const seen: string[] = [];
    const seenContents: string[] = [];
    dispatcher.onWait = async (taskId, workspace) => {
      const runDir = path.dirname(path.dirname(workspace));
      seen.push(...await tree(runDir));
      for (const file of await tree(runDir)) seenContents.push(await readFile(file, "utf8"));
      await writeFile(path.join(workspace, "store.js"), FIXED_STORE);
      await seedSession(env.home, taskId, "a1");
    };
    const runner = new BenchmarkRunner(dispatcher, {
      home: env.home, parent: "matrix:test", dir: env.dir, caseTimeoutMs: 5_000,
      now: () => 1_700_000_000_000,
    });
    const record = await runner.run(codingSuite(BROKEN_STORE), "fp", await benchmarkEpoch(env.home));
    assert.equal(record.outcomes[0]!.verified, true);
    assert.ok(!seen.some(file => file.includes(`${path.sep}preflight${path.sep}`)),
      "preflight material is reachable from the worker's run tree");
    const evidence = await tree(path.join(path.dirname(env.dir), "evidence", record.id));
    assert.ok(!evidence.some(file => file.includes(`${path.sep}preflight${path.sep}`)),
      "preflight material leaves nothing behind in evidence either");
    assert.ok(!seenContents.some(text => text.includes("this.#m.clear()")),
      "no reference solution text is reachable from the worker's run tree");
    assert.ok(!evidence.some(file => file.includes(`${path.sep}preflight${path.sep}`)),
      "the preflight copy of the reference solution is deleted after grading");
  } finally { await env.cleanup(); }
});

test("a later case cannot read an earlier case's solved workspace", async () => {
  const env = await environment();
  try {
    const twoCases = () => parseBenchmarkSuite({
      name: "twocase", repeats: 1,
      cases: [
        {
          id: "case-a", thinking: "xhigh",
          task: "Eine der Operationen in store.js ist fehlerhaft; node test.js muss ALL PASS ausgeben.",
          model: "homelab/qwen3.8-27b-coder",
          fixtures: [{ path: "store.js", contents: BROKEN_STORE }, { path: "test.js", contents: CONTRACT_TEST }],
          deliverables: ["store.js"], acceptance: "node test.js",
          verifier: 'node -e \'const s=require("fs").readFileSync(process.argv[1],"utf8");if(!s.includes("this.#m.clear()"))process.exit(1)\' "{workspace}/store.js"',
          referenceSolution: [{ path: "store.js", contents: FIXED_STORE }],
        },
        {
          id: "case-b", thinking: "medium",
          task: "Eine der Operationen in store.js ist fehlerhaft; node test.js muss ALL PASS ausgeben.",
          model: "homelab/qwen3.8-27b-coder",
          fixtures: [{ path: "store.js", contents: BROKEN_STORE }, { path: "test.js", contents: CONTRACT_TEST }],
          deliverables: ["store.js"], acceptance: "node test.js",
          verifier: 'node -e \'const s=require("fs").readFileSync(process.argv[1],"utf8");if(!s.includes("this.#m.clear()"))process.exit(1)\' "{workspace}/store.js"',
          referenceSolution: [{ path: "store.js", contents: FIXED_STORE }],
        },
      ],
    }, "twocase");
    const dispatcher = new FakeDispatcher();
    const siblingsDuringRun: string[][] = [];
    const solvedContentsDuringRun: string[] = [];
    dispatcher.onWait = async (taskId, workspace) => {
      const runDir = path.dirname(path.dirname(workspace));
      siblingsDuringRun.push((await readdir(path.join(runDir, "workspace")).catch(() => ["<kein Ordner>"])).sort());
      for (const file of await tree(runDir)) solvedContentsDuringRun.push(`${file}::${await readFile(file, "utf8")}`);
      await writeFile(path.join(workspace, "store.js"), FIXED_STORE);
      await seedSession(env.home, taskId, "a1", 1, workspace.includes("case-b") ? "medium" : "xhigh");
    };
    const runner = new BenchmarkRunner(dispatcher, {
      home: env.home, parent: "matrix:test", dir: env.dir, caseTimeoutMs: 5_000,
      now: () => 1_700_000_000_000,
    });
    const record = await runner.run(twoCases(), "fp", await benchmarkEpoch(env.home));
    assert.deepEqual(record.outcomes.map(outcome => outcome.caseId), ["case-a", "case-b"]);
    assert.ok(record.outcomes.every(outcome => outcome.verified), record.outcomes.map(o => o.diagnostic).join(" | "));
    assert.deepEqual(siblingsDuringRun, [["case-a-1"], ["case-b-1"]],
      "while a case runs, its workspace parent holds exactly its own directory");
    const predecessor = path.join(path.dirname(env.dir), "evidence", record.id, "workspace", "case-a-1", "store.js");
    assert.equal(await readFile(predecessor, "utf8"), FIXED_STORE, "the finished case is preserved as evidence");
    assert.ok(!(await tree(path.join(path.dirname(env.dir), "state", record.id, "workspace", "case-a-1"))).length,
      "the finished case is gone from the live run tree");
    const persisted = await readFile(path.join(path.dirname(env.dir), "state", `${record.id}`, "record.json"), "utf8").catch(async () => {
      for (const entry of await tree(path.join(env.dir))) if (entry.endsWith("record.json")) return readFile(entry, "utf8");
      return "";
    });
    assert.ok(persisted.length > 0, "the run record exists");
    assert.ok(!persisted.includes("this.#m.clear()"), "the persisted record must not contain the verifier command");
    assert.match(persisted, /"command": "sha256:/, "the verifier is recorded by fingerprint only");
    assert.ok(!solvedContentsDuringRun.some(text => text.includes("this.#m.clear()")),
      "leak: " + solvedContentsDuringRun.filter(t => t.includes("this.#m.clear()")).map(t => t.slice(0, 400)).join("\n---\n"));
  } finally { await env.cleanup(); }
});
