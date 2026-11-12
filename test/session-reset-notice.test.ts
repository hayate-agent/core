import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { ExecutionStore } from "../src/execution.js";
import { installCommands } from "../src/commands.js";
import { HarnessTuiChannel } from "../src/channels/tui.js";
import { LocalSessions } from "../src/local-sessions.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "reset-notice-"));
  const store = new ExecutionStore(path.join(home, "executions.json"));
  await store.load();
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, executionStore: store, log: () => {} });
  return { home, store, harness, runtime };
}

for (const command of ["new", "reset"]) test(`chat /${command} reports retained owners without cancellation or sensitive prompts`, async () => {
  const { home, store, harness, runtime } = await fixture();
  try {
    const channel = new MemoryChannel(); harness.addChannel(channel);
    installCommands({ harness, admins: [], approvals: { mode: "off", tools: [] }, skills: () => [] } as any);
    const key = "mem:room1", s = harness.state(key);
    const child = await store.submit(key, "one", "SECRET child", "test");
    await store.submit("other", "two", "SECRET other", "test");
    s.tasks = [{ id: "timer", state: "waiting", original: "SECRET original", next: "SECRET next", depth: 0,
      wait: { reason: "SECRET reason", nextAt: Date.now() + 60000, deadline: Date.now() + 120000 } }];
    s.loop = { prompt: "SECRET loop", everyMs: 60000, nextAt: Date.now() + 60000, paused: false };
    s.heartbeat = { ...s.loop, paused: true };
    s.goal = { text: "SECRET goal", criteria: [], paused: false, turns: 0 };
    const snapshot = () => JSON.stringify({ tasks: s.tasks, loop: s.loop, heartbeat: s.heartbeat, goal: s.goal, executions: store.list() });
    const before = snapshot();
    await harness.sessionFor(key);
    await harness.submit(msg(`/${command}`)); await harness.drained();
    const result = channel.texts().at(-1)!;
    assert.match(result, /same conversation; parent turn aborted if running and parent queue discarded/);
    assert.match(result, /conversation mem:room1/);
    assert.ok(result.includes(child.id));
    assert.match(result, /continuation timer: waiting; wait timer retained/);
    assert.match(result, /loop: active/); assert.match(result, /heartbeat: paused/); assert.match(result, /goal: active/);
    assert.doesNotMatch(result, /SECRET|other/);
    assert.equal(snapshot(), before);
    assert.deepEqual(runtime.opened.map(o => o.fresh), [false, true]);
  } finally { await harness.stop(100); await rm(home, { recursive: true, force: true }); }
});

test("inventory distinguishes empty, bounded and unavailable without creating sessions", async () => {
  const { home, store, harness } = await fixture();
  try {
    assert.match(harness.remainingWorkNotice("empty"), /^No remaining work/);
    assert.equal(harness.sessions.size, 0);
    for (let i = 0; i < 15; i++) await store.submit("owner", String(i), "SECRET", "test");
    assert.match(harness.remainingWorkNotice("owner"), /3 more/);
    store.list = () => { throw Error("SECRET IO"); };
    assert.match(harness.remainingWorkNotice("empty"), /inventory unavailable/);
    assert.doesNotMatch(harness.remainingWorkNotice("empty"), /No remaining|SECRET/);
    const absent = new Harness({ runtime: new FakeRuntime() });
    assert.match(absent.remainingWorkNotice("empty"), /cannot be ruled out/);
  } finally { await harness.stop(100); await rm(home, { recursive: true, force: true }); }
});

for (const command of ["new", "reset"]) test(`TUI /${command} retains idle old parent's child/timer and late result anchoring`, async () => {
  const { home, store, harness } = await fixture();
  try {
    const sessions = await LocalSessions.open(home, home); await sessions.create("old");
    const old = sessions.current!.key, oldId = sessions.current!.id;
    const child = await store.submit(old, "child", "SECRET", "test");
    const claimed = await store.claim(child.id);
    harness.restoreSessions([{ key: old, tasks: [{ id: "persisted", original: "SECRET", state: "waiting", depth: 0,
      wait: { reason: "SECRET", nextAt: Date.now() + 60000, deadline: Date.now() + 120000 } }] }]);
    const ui = new HarnessTuiChannel({ sessions, canSwitchSession: () => !harness.state(old).running,
      remainingWorkNotice: () => harness.remainingWorkNotice(sessions.current!.key) });
    const notes: string[] = []; (ui as any).note = (text: string) => notes.push(text);
    await (ui as any).sessionCommand(`/${command} fresh`);
    assert.notEqual(sessions.current!.key, old);
    const text = notes.join("\n");
    assert.ok(text.includes(`owned by conversation ${old}`)); assert.ok(text.includes(`/resume ${oldId}`));
    assert.match(text, /Old work is not transferred here/); assert.doesNotMatch(text, /SECRET/);
    assert.match(text, /persisted: waiting; wait timer retained/);
    assert.ok(text.includes(`dispatcher ${child.id}: running`));
    assert.equal(store.list(old)[0].status, "running");
    assert.equal(harness.state(old).tasks?.[0].state, "waiting");
    await store.complete(child.id, claimed.token!, "late result");
    assert.equal(store.list(old)[0].result, "late result");
    assert.equal(store.list(sessions.current!.key).length, 0);
  } finally { await harness.stop(100); await rm(home, { recursive: true, force: true }); }
});

test("chat reset retains existing parent abort and queue-drop semantics", async () => {
  const { home, harness } = await fixture();
  try {
    const s = harness.state("owner"), previous = await harness.sessionFor("owner");
    s.running = true; s.queue.push(msg("queued"));
    await harness.resetSession("owner");
    assert.equal((previous as any).aborted, 1); assert.equal(s.queue.length, 0); s.running = false;
  } finally { await harness.stop(100); await rm(home, { recursive: true, force: true }); }
});
