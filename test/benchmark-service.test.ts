import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Execution } from "../src/execution.js";
import { BenchmarkService } from "../src/benchmark/index.js";
import type { BenchmarkSubmitter } from "../src/benchmark/runner.js";

const SUITE_YAML = `
name: levels
repeats: 2
cases:
  - id: cache-reset
    task: Bring den Test in diesem Verzeichnis zum Laufen, ohne ihn zu veraendern.
    model: homelab/qwen3.8-27b-coder
    thinking: xhigh
    fixtures:
      - path: store.js
        contents: "const cache = {};\\n"
    acceptance: node test.js
    expectation: ALL PASS
`;

/** Same shape as a real dispatch_* worker session, so a run can prove its pin. */
async function seedSession(home: string, taskId: string) {
  const dir = path.join(home, "sessions", `dispatch_${taskId}_a1`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "2026-11-10T00-00-00-000Z_session.jsonl"), JSON.stringify({
    type: "message",
    message: { role: "assistant", model: "qwen3.8-27b-coder", thinkingLevel: "xhigh", durationMs: 1_500,
      usage: { input: 100, output: 40, totalTokens: 140 }, content: [{ type: "text", text: "fertig" }] },
  }) + "\n");
}

class FakeSubmitter implements BenchmarkSubmitter {
  inputs: string[] = [];
  pinned: unknown[] = [];
  ids: string[] = [];
  release: (() => void) | undefined;
  gate = false;
  constructor(private readonly home: string) { }
  async submitScheduled(_parent: string, requestId: string, input: string, _mandate: unknown, pinned?: unknown) {
    this.inputs.push(input);
    this.pinned.push(pinned);
    const id = `task-${requestId}`;
    this.ids.push(id);
    await seedSession(this.home, id);
    return { id };
  }
  async waitForExecution() { if (this.gate) { this.gate = false; await new Promise<void>(resolve => { this.release = resolve; }); } }
  async control() { }
  list(): Execution[] { return this.ids.map(id => ({ id, status: "completed", result: "fertig" }) as Execution); }
}

async function environment(enabled = true) {
  const home = await mkdtemp(path.join(os.tmpdir(), "benchmark-service-"));
  const dispatcher = new FakeSubmitter(home);
  const service = new BenchmarkService(dispatcher, {
    home, config: () => ({ enabled, capacity: 1, repeats: 3, caseTimeoutMs: 60_000 }),
    now: () => 1_700_000_000_000,
    // Faithful to the fixture: the untouched case is broken, the finished one passes.
    execute: async (_command: string, cwd: string) => ({
      exitCode: cwd.includes(`${path.sep}preflight${path.sep}`) ? 1 : 0, output: "ALL PASS",
    }),
  });
  return { home, dispatcher, service, cleanup: () => rm(home, { recursive: true, force: true }) };
}

test("suites are discovered from the home directory and unknown names list what exists", async () => {
  const env = await environment();
  try {
    assert.deepEqual(await env.service.suites(), []);
    await env.service.save("levels", SUITE_YAML);
    await env.service.save("anderes", SUITE_YAML.replace("name: levels", "name: anderes"));
    await mkdir(path.join(env.home, "benchmark", "suites"), { recursive: true });
    await writeFile(path.join(env.home, "benchmark", "suites", "README.md"), "kein suite");
    assert.deepEqual(await env.service.suites(), ["anderes", "levels"]);
    const { suite, source } = await env.service.load("levels");
    assert.equal(suite.cases[0]!.thinking, "xhigh");
    assert.match(source, /suites\/levels\.yaml$/);
    await assert.rejects(() => env.service.load("unbekannt"), /Unknown benchmark suite "unbekannt".*anderes, levels/s);
  } finally { await env.cleanup(); }
});

test("a suite is validated before it is written, so a half suite cannot exist", async () => {
  const env = await environment();
  try {
    await assert.rejects(() => env.service.save("kaputt", "name: kaputt\ncases:\n  - id: a\n    task: x\n    model: coder\n    thinking: xhigh\n"), /Invalid worker pin model ref/);
    assert.deepEqual(await env.service.suites(), []);
    await assert.rejects(() => env.service.save("leak", SUITE_YAML.replace("ALL PASS", "ALL PASS").replace(/ohne ihn zu veraendern\./, "Sorge dafuer, dass ALL PASS steht.")), /leaks its expectation/);
    assert.deepEqual(await env.service.suites(), []);
    const target = await env.service.save("levels", SUITE_YAML);
    assert.match(await readFile(target, "utf8"), /name: levels/);
  } finally { await env.cleanup(); }
});

test("a disabled subsystem refuses to submit worker tasks at all", async () => {
  const env = await environment(false);
  try {
    await env.service.save("levels", SUITE_YAML);
    await assert.rejects(() => env.service.run("levels", "matrix:test"), /Benchmarking is disabled/);
    assert.deepEqual(env.dispatcher.inputs, [], "no task reached the dispatcher");
  } finally { await env.cleanup(); }
});

test("two runs at once are refused instead of distorting each other", async () => {
  const env = await environment();
  try {
    await env.service.save("levels", SUITE_YAML);
    env.dispatcher.gate = true;
    const first = env.service.run("levels", "matrix:test");
    while (!env.dispatcher.release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(() => env.service.run("levels", "matrix:test"), /already running since/);
    env.dispatcher.release!();
    const finished = await first;
    assert.deepEqual(finished.outcomes.map(outcome => outcome.status), ["completed", "completed"], "no run may silently fall into its timeout");
    assert.equal(env.service.status().running, null, "the slot is freed afterwards");
  } finally { await env.cleanup(); }
});

test("a run pins every submission, keeps the expectation out and is stored for reporting", async () => {
  const env = await environment();
  try {
    await env.service.save("levels", SUITE_YAML);
    const record = await env.service.run("levels", "matrix:test");
    assert.equal(record.outcomes.length, 2);
    assert.equal(env.dispatcher.inputs.length, 2);
    assert.ok(env.dispatcher.inputs.every(input => !input.includes("ALL PASS")));
    assert.deepEqual(env.dispatcher.pinned[0], { model: "homelab/qwen3.8-27b-coder", thinking: "xhigh" });
    assert.equal(record.outcomes[0]!.verified, true);

    const latest = await env.service.latest();
    assert.equal(latest.length, 1);
    assert.equal(latest[0]!.id, record.id);
    const report = await env.service.report();
    assert.match(report, /### levels — /);
    assert.match(report, /\|\s*xhigh\s*\|\s*2\s*\|\s*2\s*\|/);
    assert.equal((await env.service.latest(5, "anderes")).length, 0);
  } finally { await env.cleanup(); }
});

test("status reports the effective configuration and a broken record directory is skipped", async () => {
  const env = await environment();
  try {
    const status = env.service.status();
    assert.equal(status.enabled, true);
    assert.equal(status.config.capacity, 1);
    assert.equal(status.running, null);
    assert.match(status.runsDir, /benchmark\/runs$/);
    const broken = path.join(status.runsDir, "kaputt-1");
    await mkdir(broken, { recursive: true });
    await writeFile(path.join(broken, "record.json"), "{kein json");
    assert.deepEqual(await env.service.latest(), []);
  } finally { await env.cleanup(); }
});
