import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { Scheduler } from "../src/scheduler.js";
import { ExecutionStore } from "../src/execution.js";
import { FakeRuntime } from "./fakes.js";

const data = { sources: [{ id: "issues", locator: "tracker-project/source-id", cursor: "revision-42", observedAt: "2026-11-18T10:00:00Z" }], pending: ["issue-43 awaits authorized action"], evidence: ["retained:report-42"] };
const job = { name: "check", schedule: "0 * * * *", prompt: "Inspect configured tracker changes", deliver: "local" };
test("cron source checkpoint survives fresh occurrence and serialized restart with pending work", async t => {
  let h: Harness, stage = true;
  const runtime = new FakeRuntime(() => { if (stage) h.stageCronCheckpoint("cron:check", data); return "Source inspected; pending work retained"; });
  h = new Harness({ runtime, completionCheck: async () => ({ state: "completed" }) }); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const scheduler = new Scheduler(h, { timezone: "UTC" });
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:check");
  assert.equal(h.state("cron:check").cronCheckpoint!.sources[0].cursor, "revision-42");
  stage = false;
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:check");
  assert.match(runtime.sessions.get("cron:check")!.options[0].instructions!, /tracker-project\/source-id/);
  assert.match(runtime.sessions.get("cron:check")!.options[0].instructions!, /issue-43 awaits/);
  const restored = new Harness({ runtime: new FakeRuntime() }); restored.restoreSessions(JSON.parse(JSON.stringify(h.snapshotSessions()))); t.after(() => restored.stop(0));
  assert.equal(restored.state("cron:check").cronCheckpoint!.sources[0].cursor, "revision-42");
  await scheduler.runJob({ ...job, prompt: "Changed source scope" }); await h.waitForSessionIdle("cron:check");
  assert.match(runtime.sessions.get("cron:check")!.options[0].instructions!, /Configuration changed/);
});
test("settled cron checkpoint is recovered after archive failure without another model effect", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cron-checkpoint-")); t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new ExecutionStore(path.join(home, "executions.json")); await ledger.load(); let fail = true, calls = 0;
  let h: Harness;
  const runtime = new FakeRuntime(() => { calls++; h.stageCronCheckpoint("cron:check", data); return "Report"; });
  h = new Harness({ runtime, executionStore: ledger, completionCheck: async () => ({ state: "completed" }), reportOutput: async () => { if (fail) throw Error("archive unavailable"); } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await new Scheduler(h, { timezone: "UTC" }).runJob({ ...job, audience: "agent" }); await h.waitForSessionIdle("cron:check");
  fail = false; await h.tick(); await h.waitForSessionIdle("cron:check");
  assert.equal(calls, 1); assert.equal(h.state("cron:check").cronCheckpoint!.pending[0], data.pending[0]);
});
test("same occurrence can advance again but a genuinely stale occurrence cannot overwrite newer progress", async t => {
  let h: Harness, calls = 0;
  const runtime = new FakeRuntime(() => { calls++; h.stageCronCheckpoint("cron:check", data); return "Checkpoint with work remaining"; });
  h = new Harness({ runtime, completionCheck: async () => ({ state: "waiting" }) }); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await new Scheduler(h, { timezone: "UTC" }).runJob(job); await h.waitForSessionIdle("cron:check");
  const state = h.state("cron:check"), owner = h.snapshotSessions()[0].tasks![0];
  assert.equal(owner.cronCheckpointRevision, 1);
  // Exact old task is resumed through the existing persisted-wait owner.
  state.current = { source: "cron", sessionKey: state.key, text: owner.original, taskId: owner.id, cronScope: owner.cronScope };
  assert.doesNotThrow(() => h.stageCronCheckpoint(state.key, data));
  state.cronCheckpoint!.revision = 2;
  assert.throws(() => h.stageCronCheckpoint(state.key, data), /advanced/);
  state.current = undefined;
  assert.equal(calls, 1);
});

test("stop during held report archival cannot publish a cancelled checkpoint", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "cron-stop-checkpoint-")); t.after(() => rm(home, { recursive: true, force: true }));
  const ledger = new ExecutionStore(path.join(home, "executions.json")); await ledger.load();
  let entered!: () => void, release!: () => void, turnId = "";
  const archival = new Promise<void>(resolve => { entered = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let h: Harness;
  h = new Harness({ runtime: new FakeRuntime(() => { h.stageCronCheckpoint("cron:check", data); return "Report"; }), executionStore: ledger,
    completionCheck: async () => ({ state: "completed" }), reportOutput: async input => { turnId = input.executionTurnId!; entered(); await held; } });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await new Scheduler(h, { timezone: "UTC" }).runJob({ ...job, audience: "agent" }); await archival;
  assert.equal(h.state("cron:check").cronCheckpoint, undefined, "not projected before the yielding archive boundary");
  await h.stopConversation("cron:check");
  assert.equal(ledger.turn(turnId, "cron:check")!.settlement!.cronCheckpoint, undefined);
  release(); await h.waitForSessionIdle("cron:check");
  assert.equal(h.state("cron:check").cronCheckpoint, undefined);
  assert.equal(h.snapshotSessions()[0].tasks![0].cronCheckpointRevision, 0);
});

test("failed model turn never publishes a staged cursor", async t => {
  let h: Harness;
  const runtime = new FakeRuntime(() => { h.stageCronCheckpoint("cron:check", data); throw Error("model interrupted"); });
  h = new Harness({ runtime }); h.onStateChange = async () => {}; t.after(() => h.stop(0));
  await new Scheduler(h, { timezone: "UTC" }).runJob(job); await h.waitForSessionIdle("cron:check");
  assert.equal(h.state("cron:check").cronCheckpoint, undefined);
  assert.throws(() => h.stageCronCheckpoint("cron:check", data), /Active configured/);
});
