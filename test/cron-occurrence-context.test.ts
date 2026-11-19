import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { Scheduler } from "../src/scheduler.js";
import { FakeRuntime, FakeSession } from "./fakes.js";
import type { OpenSessionOptions, RuntimeSession } from "../src/types.js";

class RetainedRuntime extends FakeRuntime {
  history = new Map<string, FakeSession>();
  override async open(key: string, options: OpenSessionOptions = {}): Promise<RuntimeSession> {
    this.opened.push({ key, fresh: !!options.fresh });
    if (options.sessionId) {
      const session = this.history.get(options.sessionId);
      if (!session) throw Error("Missing exact occurrence transcript");
      this.sessions.set(key, session); return session;
    }
    const session = new FakeSession(key, (text, k) => this.answer(text, k));
    const id = `occurrence-${this.history.size}`;
    session.status = () => ({ sessionId: id, busy: session.busy, messages: session.prompts.length * 2 });
    this.sessions.set(key, session); this.history.set(id, session); return session;
  }
}
const job = { name: "status", schedule: "0 * * * *", prompt: "Inspect current state; never replay effects", deliver: "local" };

test("new cron occurrences use fresh transcripts plus bounded previous evidence, preserving originals", async t => {
  const runtime = new RetainedRuntime(() => "First result " + "x".repeat(12000));
  const h = new Harness({ runtime, completionCheck: async () => ({ state: "completed" }) });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  const scheduler = new Scheduler(h, { timezone: "UTC" });
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:status");
  const first = runtime.sessions.get("cron:status")!, firstTask = h.state("cron:status").tasks![0];
  runtime.answer = () => "Second result";
  await scheduler.runJob(job); await h.waitForSessionIdle("cron:status");
  const second = runtime.sessions.get("cron:status")!;
  assert.notEqual(first.status().sessionId, second.status().sessionId);
  assert.equal(first.prompts.length, 1); assert.equal(second.prompts.length, 1);
  assert.equal(firstTask.cronComparison!.length, 2000);
  assert.equal(first.prompts[0].includes(job.prompt), true, "original transcript remains retained");
  assert.match(second.options[0].instructions!, /Previous completed cron occurrence/);
  assert.match(second.options[0].instructions!, /untrusted comparison evidence/);
  assert(!second.options[0].instructions!.includes("x".repeat(2001)));
  assert.deepEqual(runtime.opened.map(row => row.fresh), [true, true]);
});

test("restored unfinished cron reopens its exact transcript after a newer occurrence", async t => {
  const runtime = new RetainedRuntime(() => "Recovered result");
  const old = await runtime.open("cron:status", { fresh: true });
  await old.prompt("Unfinished occurrence with uncertain effect evidence");
  const oldId = old.status().sessionId;
  await runtime.open("cron:status", { fresh: true });
  const h = new Harness({ runtime, completionCheck: async () => ({ state: "completed" }) });
  h.onStateChange = async () => {}; t.after(() => h.stop(0));
  h.restoreSessions([{ key: "cron:status", tasks: [{ id: "old", original: job.prompt, state: "active", depth: 0, recoveryEnrollment: "current", runtimeSessionId: oldId }] }]);
  h.restorePending([{ id: "old", taskId: "old", source: "cron", sessionKey: "cron:status", text: job.prompt, started: true }]);
  h.releaseRestored(); await h.waitForSessionIdle("cron:status");
  assert.equal(runtime.sessions.get("cron:status")!.status().sessionId, oldId);
  assert.equal(runtime.sessions.get("cron:status")!.prompts.length, 2);
  assert.equal(h.snapshotSessions()[0].tasks![0].runtimeSessionId, oldId);
});

test("failed cron binding save is retried before prompting the same transcript", async t => {
  let prompts = 0, saves = 0, failed = false;
  const runtime = new RetainedRuntime(() => { prompts++; assert(saves >= 2); return "Settled"; });
  const h = new Harness({ runtime, completionCheck: async () => ({ state: "completed" }) });
  t.after(() => h.stop(0));
  h.restoreSessions([{ key: "cron:status", tasks: [{ id: "previous", original: job.prompt, state: "completed", depth: 0, cronComparison: "Retained comparison after yield" }] }]);
  h.onStateChange = async () => {
    if (h.state("cron:status").tasks?.some(task => task.runtimeSessionId)) {
      saves++;
      if (!failed) { failed = true; throw Error("binding disk failure"); }
    }
  };
  await new Scheduler(h, { timezone: "UTC" }).runJob(job); await h.waitForSessionIdle("cron:status");
  assert(failed); assert.equal(prompts, 0);
  const id = h.state("cron:status").tasks!.at(-1)!.runtimeSessionId;
  await h.tick(); await h.waitForSessionIdle("cron:status");
  assert.equal(prompts, 1); assert.equal(h.state("cron:status").tasks!.at(-1)!.runtimeSessionId, id);
  assert.match(runtime.sessions.get("cron:status")!.options[0].instructions!, /Retained comparison after yield/);
  assert.equal(runtime.history.size, 1);
});

test("legacy unfinished cron is durably bound before fresh rotation",  async t => {
  const runtime = new RetainedRuntime();
  const old = await runtime.open("cron:status");
  const h = new Harness({ runtime, completionCheck: async () => ({ state: "completed" }) });
  let boundBeforeRotation = false;
  h.onStateChange = async () => {
    const legacy = h.state("cron:status").tasks?.find(task => task.id === "legacy");
    if (legacy?.runtimeSessionId) {
      assert.equal(legacy.runtimeSessionId, old.status().sessionId);
      boundBeforeRotation = true;
    }
  }; t.after(() => h.stop(0));
  const open = runtime.open.bind(runtime);
  runtime.open = async (key, options) => { if (options?.fresh) assert(boundBeforeRotation); return open(key, options); };
  h.state("cron:status").session = old;
  h.restoreSessions([{ key: "cron:status", tasks: [{ id: "legacy", original: "Unfinished old work", state: "blocked", depth: 0 }] }]);
  await new Scheduler(h, { timezone: "UTC" }).runJob(job); await h.waitForSessionIdle("cron:status");
  assert.equal(runtime.opened.length, 2);
  assert.notEqual(runtime.sessions.get("cron:status")!.status().sessionId, old.status().sessionId);
  assert.equal(h.snapshotSessions()[0].tasks![0].runtimeSessionId, old.status().sessionId);
  assert(runtime.history.has(old.status().sessionId));
});
