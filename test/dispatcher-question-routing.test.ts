import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import type { Inbound } from "../src/types.js";
import { FakeRuntime } from "./fakes.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatcher-question-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const start = Date.now();
  let now = start;
  const file = path.join(home, "executions.json");
  const store = new ExecutionStore(file, { now: () => now }); await store.load();
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, executionStore: store, busyMode: "queue", tickMs: 60000,
    hostEventAllowed: input => store.questionAllowed(input) });
  harness.onStateChange = async () => {};
  t.after(() => harness.stop(0));
  await harness.accept({ id: "operator", sessionKey: "main", source: "channel", text: "Fix routing; tests only; no deploy" });
  await harness.waitForSessionIdle("main");
  const parent = harness.sessions.get("main")!.task!;
  const child = await store.submit("main", "child", "Fix routing", "direct", 1,
    { taskId: parent.id, original: parent.original, depth: parent.depth, anchor: parent.anchor, expiresAt: start + 60000 });
  const claim = await store.claim(child.id);
  await store.ask(child.id, claim.token!, "Which regression is required?");
  const task = store.list("main").find(task => task.id === child.id)!;
  const event = store.events().find(event => event.type === "question")!;
  const input: Inbound = { id: `dispatch-event:${event.id}`, source: "host", sessionKey: "main",
    hostEvent: { executionId: child.id, question: { id: task.question!.id, eventId: event.id } },
    text: store.questionText(child.id, task.question!) };
  return { store, harness, runtime, file, input, parent, child, event, expire: () => { now = start + 60000; } };
}

test("question receipt retains original Main mandate and is durable after outbox ack", async t => {
  const f = await fixture(t);
  assert.equal(f.store.questionAllowed(f.input), true);
  assert.equal(f.harness.resultMandate(f.input)?.original, f.parent.original);
  const bridge = new DispatcherRuntime(f.harness, f.store);
  assert.equal(bridge.hostEventAllowed(f.input), true);
  bridge.guardHostEvent("main", f.input);
  await f.store.ack(f.event.id);
  const reopened = new ExecutionStore(f.file); await reopened.load();
  assert.equal(reopened.questionAllowed(f.input), true);
  let calls = 0;
  f.runtime.sessions.get("main")!.prompt = async (_text, options) => {
    calls++;
    assert.match(options?.instructions ?? "", /Original mandate/);
    assert.equal(f.harness.resultMandate(f.input)?.original, f.parent.original);
    return "Question received by Main";
  };
  await f.harness.accept(f.input); await f.harness.waitForSessionIdle("main");
  await f.harness.accept({ ...f.input }); await f.harness.waitForSessionIdle("main");
  assert.equal(calls, 1);
});

for (const drift of ["foreign", "event", "question", "text", "expired", "stopped", "answered"])
  test(`question receipt rejects ${drift}`, async t => {
    const f = await fixture(t);
    const input = structuredClone(f.input);
    if (drift === "foreign") input.sessionKey = "other-main";
    if (drift === "event") input.hostEvent!.question!.eventId = "other-event";
    if (drift === "question") input.hostEvent!.question!.id = "old-question";
    if (drift === "text") input.text = "invented host instructions";
    if (drift === "expired") f.expire();
    if (drift === "stopped") await f.store.control(f.child.id, "cancel");
    if (drift === "answered") await f.store.answer("main", f.child.id, f.input.hostEvent!.question!.id, "Use the routing test");
    assert.equal(f.store.questionAllowed(input), false);
    assert.equal(f.harness.resultMandate(input), undefined);
  });
