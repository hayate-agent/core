import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { StartupNotice, startupNoticeTarget } from "../src/startup-notice.js";
import { FakeRuntime, MemoryChannel, ROOM } from "./fakes.js";

test("missing home uses exactly one known user room, not stale API/worker destinations", () => {
  const channels = new Set(["matrix", "api", "dispatch", "console", "webui"]);
  const room = { channel: "matrix", target: "!user-room" };
  const sessions = [
    { key: "matrix:!user-room", replyTo: room },
    { key: "matrix:!user-room:thread", replyTo: { ...room, thread: "$old-thread" } },
    { key: "api:old-run", replyTo: { channel: "api", target: "old-run" } },
    { key: "webui:old-browser", replyTo: { channel: "webui", target: "old-browser" } },
    { key: "dispatch:worker", replyTo: { channel: "dispatch", target: "worker" } },
    { key: "console:local", replyTo: { channel: "console", target: "local" } },
  ];
  assert.deepEqual(startupNoticeTarget(undefined, sessions, channels), room);
  const explicit = { ...room, target: "!configured", thread: "$configured-thread" };
  assert.deepEqual(startupNoticeTarget(explicit, sessions, channels), explicit);
  assert.equal(startupNoticeTarget(undefined, [...sessions, { key: "matrix:!other", replyTo: { ...room, target: "!other" } }], channels), undefined);
  assert.equal(startupNoticeTarget(undefined, sessions, new Set(["api"])), undefined);
});

const settle = () => new Promise(resolve => setImmediate(resolve));
function notice(h: Harness, restarted = true) {
  return new StartupNotice({ agent: "agent-fixture", build: { version: "0.1.251", revision: "a".repeat(40) }, restarted,
    post: (input, text) => h.post(input, text), log: () => {} });
}

test("ready notice is persisted before send, once per boot, without model work or task changes", async t => {
  const runtime = new FakeRuntime(() => { throw Error("readiness must not prompt a model"); });
  const h = new Harness({ runtime, tickMs: 60000 }); const channel = new MemoryChannel(); h.addChannel(channel);
  t.after(() => h.stop(0));
  h.paused = true;
  h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, task: { id: "retained", original: "approved work", state: "stopped", depth: 2 } }]);
  const task = structuredClone(h.snapshotSessions()[0].task); let persisted = false;
  const send = channel.send.bind(channel); channel.send = async (...args) => { assert.equal(persisted, true); await send(...args); };
  h.onStateChange = async () => { if (!persisted) assert.equal(h.outboxEntries().length, 1); persisted = true; };
  const n = notice(h); n.ready(ROOM); n.ready(ROOM);
  for (let i = 0; i < 10 && !channel.sent.length; i++) await settle();
  assert.equal(channel.sent.length, 1); assert.deepEqual(channel.sent[0].to, ROOM);
  assert.match(channel.sent[0].text, /Restart complete.*ready again/);
  assert.match(channel.sent[0].text, /0\.1\.251.*aaaaaaaaaaaa/);
  assert.deepEqual(h.snapshotSessions()[0].task, task); assert.equal(h.paused, true); assert.equal(runtime.sessions.size, 0);
});

test("failed delivery survives restoration and retries with the same delivery ID", async t => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); const c = new MemoryChannel(); h.addChannel(c);
  t.after(() => h.stop(0)); h.onStateChange = async () => {};
  let attempts = 0; c.send = async () => { attempts++; throw Error("transport disconnected"); };
  notice(h).ready(ROOM);
  for (let i = 0; i < 20 && !attempts; i++) await settle();
  assert.equal(attempts, 1); const saved = structuredClone(h.outboxEntries()); assert.equal(saved.length, 1);
  const next = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); const nc = new MemoryChannel(); next.addChannel(nc);
  t.after(() => next.stop(0)); next.onStateChange = async () => {};
  next.restoreOutbox(saved); next.releaseRestored();
  for (let i = 0; i < 20 && !nc.sent.length; i++) await settle();
  assert.equal(nc.sent.length, 1); assert.equal(nc.sent[0].meta?.deliveryId, saved[0].id);
  assert.equal(next.pendingInputs().length, 0);
});

test("first startup is not mislabeled as restart; no recipient means log only", async t => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 }); const c = new MemoryChannel(); h.addChannel(c);
  t.after(() => h.stop(0)); h.onStateChange = async () => {};
  notice(h, false).ready(ROOM);
  for (let i = 0; i < 10 && !c.sent.length; i++) await settle();
  assert.match(c.sent[0].text, /Started and ready/); assert.doesNotMatch(c.sent[0].text, /Restart/);
  notice(h).ready(); assert.equal(h.pendingInputs().length, 0); assert.equal(h.outboxEntries().length, 0);
});

test("startup status is not blocked behind an active conversation's model turn", async t => {
  const runtime = new FakeRuntime(); const working = await runtime.open("mem:room1"); const release = working.hold();
  const h = new Harness({ runtime, tickMs: 60000 }); const c = new MemoryChannel(); h.addChannel(c);
  h.onStateChange = async () => {}; t.after(async () => { release(); await h.stop(0); });
  h.sessions.set("mem:room1", { key: "mem:room1", session: working, running: true, queue: [], outbox: [], lastActivity: Date.now() });
  notice(h).ready(ROOM);
  for (let i = 0; i < 10 && !c.sent.length; i++) await settle();
  assert.equal(c.sent.length, 1); assert.equal(working.prompts.length, 0);
});
