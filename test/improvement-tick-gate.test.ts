import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ImprovementController } from "../src/improvement.js";
import nightlyDefault from "../src/builtin-plugins/nightly-default.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, ROOM } from "./fakes.js";

async function setup(t: any, delegated: () => any[] = () => []) {
  const home = await mkdtemp(path.join(os.tmpdir(), "tick-gate-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, "improvement.yaml"), "enabled: true\nmaxTurns: 2\ntimezone: UTC\n");
  const now = Date.parse("2026-10-24T23:00:00Z");
  const harness = new Harness({ runtime: new FakeRuntime(() => "Test baseline verified"), tickMs: 60000 });
  harness.addChannel(new MemoryChannel()); harness.home = ROOM;
  const lines: string[] = [];
  const controller = new ImprovementController(home, harness, "UTC", () => now, nightlyDefault, undefined, delegated, m => lines.push(m));
  const opts = (harness as any).opts; // same hooks as the CLI
  opts.beforeTurn = (input: any) => controller.before(input);
  opts.afterTurn = async (input: any, reply: string) => { await controller.completed(input, reply); return reply; };
  return { harness, controller, lines };
}

test("tick gate: global interactive.running lock is reported without content and without admission", async t => {
  const { harness, controller, lines } = await setup(t);
  harness.state("mem:interactive").running = true;
  await controller.tick(true);
  assert.equal(harness.sessions.has("improvement:nightly"), false);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^tick-gate busy /);
  const d = JSON.parse(lines[0].slice("tick-gate busy ".length));
  assert.equal(d.ownerBusy, false); assert.equal(d.sessionsRunning, 1); assert.equal(d.paused, false);
  assert.doesNotMatch(lines[0], /interactive/, "no session keys logged");
  await controller.tick(true); assert.equal(lines.length, 1, "identical consecutive outcome logged once");
  harness.state("mem:interactive").running = false;
  await controller.tick(false); await harness.drained();
  assert.equal(harness.sessions.get("improvement:nightly")?.session?.status().messages, 2);
});

test("tick gate: global queue lock and paused are reported", async t => {
  const { harness, controller, lines } = await setup(t);
  harness.state("mem:interactive").queue.push({ id: "q", sessionKey: "mem:interactive", source: "user", text: "SECRET" } as any);
  await controller.tick(true);
  assert.equal(harness.sessions.has("improvement:nightly"), false);
  assert.equal(JSON.parse(lines.at(-1)!.slice("tick-gate busy ".length)).sessionsQueued, 1);
  assert.doesNotMatch(lines.join("\n"), /SECRET/);
  harness.state("mem:interactive").queue.length = 0;
  harness.paused = true;
  await controller.tick(true);
  assert.equal(JSON.parse(lines.at(-1)!.slice("tick-gate busy ".length)).paused, true);
  assert.equal(harness.sessions.has("improvement:nightly"), false);
});

test("tick gate: running delegate counts as owner busy", async t => {
  const tasks: any[] = [];
  const { harness, controller, lines } = await setup(t, () => tasks);
  await controller.tick(true); await harness.drained(); // creates tonight's state and runs turn 1
  tasks.push({ id: "d", parent: "improvement:nightly", status: "running" });
  await controller.tick(true); await harness.drained();
  assert.equal((harness as any).runtime.opened.filter((o: any) => o.key === "improvement:nightly").length, 1, "no second turn while delegate runs");
  const d = JSON.parse(lines.at(-1)!.slice("tick-gate busy ".length));
  assert.equal(d.ownerBusy, true); assert.equal(d.delegatedActive, 1);
});

test("tick gate: checking and strategyChanging re-entry, window and closed night are reported", async t => {
  const { harness, controller, lines } = await setup(t);
  (controller as any).checking = true;
  await controller.tick(true);
  assert.match(lines.at(-1)!, /^tick-gate reentrant .*"checking":true/);
  (controller as any).checking = false; (controller as any).strategyChanging = true;
  await controller.tick(true);
  assert.match(lines.at(-1)!, /^tick-gate reentrant .*"strategyChanging":true/);
  (controller as any).strategyChanging = false;
  // Closed night: budget of 2 turns exhausted.
  for (let i = 0; i < 4; i++) { await controller.tick(true); await harness.drained(); }
  assert.match(lines.at(-1)!, /^tick-gate night-closed .*"turns":2,"maxTurns":2/);
  // Outside window.
  const out = await setup(t);
  const late = new ImprovementController((out.controller as any).home, out.harness, "UTC", () => Date.parse("2026-10-25T12:00:00Z"), nightlyDefault, undefined, undefined, m => out.lines.push(m));
  await late.tick(true);
  assert.match(out.lines.at(-1)!, /^tick-gate window .*"active":false/);
});
