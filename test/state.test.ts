import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { approvalPreview, Harness } from "../src/harness.js";
import { StateStore } from "../src/state.js";
import { FakeRuntime } from "./fakes.js";

test("state store round-trips, writes atomically with 0600", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-state-"));
  const store = new StateStore(path.join(dir, "state.json"));
  assert.equal(await store.load(), undefined);
  await store.save({ version: 1, paused: false, busyMode: "steer", sessions: [], cronOverrides: { x: false, y: true } });
  const again = await new StateStore(path.join(dir, "state.json")).load();
  assert.equal(again?.busyMode, "steer");
  assert.deepEqual(again?.cronOverrides, { x: false, y: true });
  assert.equal((await stat(path.join(dir, "state.json"))).mode & 0o777, 0o600);
  JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
});

test("state store surfaces read errors instead of treating them as first run", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-state-"));
  await assert.rejects(new StateStore(dir).load());
});

test("state store recovers after a failed write", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-state-"));
  const blocker = path.join(dir, "blocker");
  await writeFile(blocker, "x"); // a file where a directory is expected → mkdir fails
  const bad = new StateStore(path.join(blocker, "state.json"));
  const st = { version: 1 as const, paused: false, busyMode: "queue" as const, sessions: [] };
  await assert.rejects(bad.save(st));
  await rm(blocker);
  await bad.save(st); // same content, must still be written after the failure
  assert.equal((await bad.load())?.busyMode, "queue");
});

test("harness.stop drains queued work before aborting", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.sessionFor("k");
  const release = runtime.sessions.get("k")!.hold();
  h.enqueue({ sessionKey: "k", text: "a", source: "api" });
  h.enqueue({ sessionKey: "k", text: "b", source: "api" });
  setTimeout(release, 10);
  await h.stop(1000);
  assert.deepEqual(runtime.sessions.get("k")!.prompts, ["a", "b"]);
  assert.equal(runtime.sessions.get("k")!.aborted, 0);
});

test("harness.stop aborts after the drain timeout", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.sessionFor("k");
  runtime.sessions.get("k")!.hold(); // never released
  h.enqueue({ sessionKey: "k", text: "stuck", source: "api" });
  await new Promise((r) => setImmediate(r));
  h.enqueue({ sessionKey: "k", text: "waiting", source: "channel" });
  h.enqueue({ sessionKey: "k", text: "tick", source: "heartbeat" });
  const unfinished = await h.stop(20);
  assert.equal(runtime.sessions.get("k")!.aborted, 1);
  assert.deepEqual(unfinished.map((i) => i.text), ["stuck", "waiting"], "deadline fallback preserves interrupted work; heartbeats are regenerated");
});

test("accept persists the input before acknowledging; finished turns leave the inbox", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  const snapshots: string[][] = [];
  h.onStateChange = async () => {
    snapshots.push(h.pendingInputs().map((i) => i.text));
  };
  await h.sessionFor("k");
  const release = runtime.sessions.get("k")!.hold();
  await h.accept({ id: "$1", sessionKey: "k", text: "do it", source: "channel" });
  assert.deepEqual(snapshots.at(-1), ["do it"], "durable before ack");
  await h.accept({ id: "$1", sessionKey: "k", text: "do it", source: "channel" }); // redelivery
  assert.deepEqual(h.pendingInputs().map((i) => i.text), ["do it"], "duplicate dropped");
  release();
  await h.drained();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(snapshots.at(-1), []);
});

test("completed inputs are not run again on redelivery (seen ids persist)", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.accept({ id: "$9", sessionKey: "k", text: "deploy", source: "channel" });
  await h.drained();
  const h2 = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  h2.restoreSeen(h.seenIds());
  await h2.accept({ id: "$9", sessionKey: "k", text: "deploy", source: "channel" });
  await h2.drained();
  assert.deepEqual(runtime.sessions.get("k")!.prompts, ["deploy"]);
});

test("redelivered batch only runs the parts not seen before", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.accept({ id: "$a", parts: [{ id: "$a", text: "eins" }, { id: "$b", text: "zwei" }], sessionKey: "k", text: "eins\nzwei", source: "channel" });
  await h.accept({ id: "$b", parts: [{ id: "$b", text: "zwei" }, { id: "$c", text: "drei" }], sessionKey: "k", text: "zwei\ndrei", source: "channel" });
  await h.drained();
  assert.deepEqual(runtime.sessions.get("k")!.prompts, ["eins\nzwei", "drei"]);
});

test("commands complete before acceptance resolves", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  let done = false;
  h.commandHandler = async () => {
    await new Promise((r) => setTimeout(r, 5));
    done = true;
    return true;
  };
  await h.accept({ id: "$c", sessionKey: "k", text: "/pause", source: "channel" });
  assert.equal(done, true);
});

test("commands never enter the durable inbox", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  h.commandHandler = async () => true;
  let snapshot: string[] = ["x"];
  h.onStateChange = () => { snapshot = h.pendingInputs().map((input) => input.text); };
  await h.accept({ id: "$pause", sessionKey: "k", text: "/pause", source: "channel" });
  assert.deepEqual(snapshot, []);
  assert.deepEqual(h.seenIds(), ["$pause"]);
});

test("restored turns are held against startup producers until release", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  h.restorePending([{ id: "$restore", sessionKey: "k", text: "restored", source: "channel" }]);
  await h.submit({ id: "$startup", sessionKey: "k", text: "startup producer", source: "cron" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.sessions.get("k")?.prompts ?? [], []);
  assert.deepEqual(h.pendingInputs().map((input) => input.id), ["$restore", "$startup"]);
  h.releaseRestored();
  await h.drained();
  assert.deepEqual(runtime.sessions.get("k")!.prompts, ["restored", "startup producer"]);
});

test("acceptance persistence gates an input behind an already-running turn", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.sessionFor("k");
  const release = runtime.sessions.get("k")!.hold();
  h.enqueue({ sessionKey: "k", text: "first", source: "api" });
  await new Promise((resolve) => setImmediate(resolve));
  let saveStarted!: () => void;
  const started = new Promise<void>((resolve) => { saveStarted = resolve; });
  let persist!: () => void;
  const gate = new Promise<void>((resolve) => { persist = resolve; });
  h.onStateChange = async () => { saveStarted(); await gate; };
  const accepting = h.accept({ id: "$next", sessionKey: "k", text: "second", source: "channel" });
  await started;
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.sessions.get("k")!.prompts, ["first"]);
  persist();
  await accepting;
  await h.drained();
  assert.deepEqual(runtime.sessions.get("k")!.prompts, ["first", "second"]);
});

test("a command interrupted by shutdown is not acknowledged: not in inbox, id not persisted as seen", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  h.commandHandler = async () => {
    await gate;
    return true;
  };
  const accepting = h.accept({ id: "$compact", sessionKey: "k", text: "/compress", source: "channel" });
  await new Promise((resolve) => setImmediate(resolve));
  const unfinished = await h.stop(0);
  assert.deepEqual(unfinished, []);
  assert.deepEqual(h.seenIds(), []); // the channel redelivers it after restart
  release();
  await accepting;
});

test("a turn finishing after the shutdown snapshot records no reply (no double execution)", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.sessionFor("k");
  const fake = runtime.sessions.get("k")!;
  const release = fake.hold();
  fake.abort = async () => {}; // runtime ignores abort; the prompt completes later
  h.enqueue({ sessionKey: "k", text: "slow", source: "api", replyTo: { channel: "x", target: "y" } });
  await new Promise((r) => setImmediate(r));
  const unfinished = await h.stop(0);
  assert.deepEqual(unfinished.map((i) => i.text), ["slow"]);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(h.outboxEntries(), []);
});

test("pinned seen ids survive eviction until unpinned", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  h.paused = true;
  h.pinSeen(["$first"]);
  await h.accept({ id: "$first", sessionKey: "k", text: "first", source: "channel" });
  h.restoreSeen(Array.from({ length: Harness.SEEN_MAX + 10 }, (_, i) => `$x${i}`));
  assert.ok(h.seenIds().includes("$first"));
  await h.accept({ id: "$first", sessionKey: "k", text: "first", source: "channel" }); // redelivery
  assert.equal(h.pendingInputs().length, 1);
  h.unpinSeen(["$first"]);
  h.restoreSeen(["$y"]);
  assert.ok(!h.seenIds().includes("$first"));
});

test("restored seen ids stay complete until the first channel checkpoint", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  const ids = Array.from({ length: Harness.SEEN_MAX + 50 }, (_, i) => `$r${i}`);
  h.restoreSeen(ids);
  h.restoreSeen(["$late"]);
  assert.equal(h.seenIds().length, ids.length + 1);
  h.unpinSeen([]); // channel committed its checkpoint
  assert.equal(h.seenIds().length, Harness.SEEN_MAX);
});

test("drained() resolves when a command acceptance finishes", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  let release!: () => void;
  h.commandHandler = () => new Promise<boolean>((r) => (release = () => r(true)));
  const accepting = h.accept({ id: "$c", sessionKey: "k", text: "/status", source: "channel" });
  await new Promise((r) => setImmediate(r));
  let drained = false;
  const waiting = h.drained().then(() => (drained = true));
  release();
  await accepting;
  await Promise.race([waiting, new Promise((r) => setTimeout(r, 50))]);
  assert.equal(drained, true);
});

test("durable write replaces the file atomically with mode 0600", async () => {
  const { writeFileDurable } = await import("../src/durable.js");
  const { mkdtemp, readFile, stat, readdir } = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = await mkdtemp(pathMod.join(os.tmpdir(), "vanillacore-harness-durable-"));
  const file = pathMod.join(dir, "x.json");
  await writeFileDurable(file, "one");
  await writeFileDurable(file, "two");
  assert.equal(await readFile(file, "utf8"), "two");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dir), ["x.json"]);
});

test("a command applied before a failed save is not applied again on redelivery", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  let toggles = 0;
  h.commandHandler = async () => {
    toggles++;
    return true;
  };
  let fail = true;
  h.onStateChange = async () => {
    if (fail) throw new Error("disk full");
  };
  await assert.rejects(h.accept({ id: "$yolo", sessionKey: "k", text: "/yolo", source: "channel" }), /disk full/);
  fail = false;
  await h.accept({ id: "$yolo", sessionKey: "k", text: "/yolo", source: "channel" });
  assert.equal(toggles, 1);
});

test("a turn completing during the shutdown wait records no reply (snapshot stays consistent)", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  await h.sessionFor("a");
  await h.sessionFor("b");
  const relA = runtime.sessions.get("a")!.hold();
  runtime.sessions.get("b")!.hold();
  runtime.sessions.get("a")!.abort = async () => {};
  runtime.sessions.get("b")!.abort = async () => {}; // b never finishes
  h.enqueue({ sessionKey: "a", text: "A", source: "api", replyTo: { channel: "x", target: "y" } });
  h.enqueue({ sessionKey: "b", text: "B", source: "api", replyTo: { channel: "x", target: "y" } });
  await new Promise((r) => setImmediate(r));
  h.paused = true;
  const stopping = h.stop(200);
  await new Promise((r) => setTimeout(r, 20));
  relA(); // A finishes during the wait
  const unfinished = await stopping;
  assert.deepEqual(unfinished.map((i) => i.text).sort(), ["A", "B"]);
  assert.deepEqual(h.outboxEntries(), []);
});

test("approval preview hides all arbitrary argument values", () => {
  // Fake values, assembled at runtime so secret scanners do not flag the test itself.
  const gh = ["gh", "p_", "x".repeat(24)].join("");
  const cmd = `curl -H 'Authorization: Bear${"er"} dummyvalue' -d API_${"KEY"}=dummykey https://x && echo ${gh}`;
  const preview = approvalPreview("bash", { command: cmd, [`pass${"word"}`]: "dummypw" });
  assert.equal(preview, "shell action: curl; arguments hidden");
  assert.doesNotMatch(preview, /dummyvalue|dummykey|dummypw/);
  assert.ok(!preview.includes(gh));
});

test("stop denies pending approvals", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  const pending = h.requestApproval("k", "bash", {});
  await new Promise((r) => setImmediate(r));
  await h.stop();
  assert.equal(await pending, false);
});

test("failed acceptance can be redelivered", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 1000, busyMode: "queue", log: () => {} });
  let fail = true;
  h.onStateChange = async () => {
    if (fail) throw new Error("disk full");
  };
  h.paused = true; // keep the input queued so we can observe it being dropped
  await assert.rejects(h.accept({ id: "$7", sessionKey: "k", text: "x", source: "channel" }));
  assert.equal(h.pendingInputs().length, 0);
  fail = false;
  await h.accept({ id: "$7", sessionKey: "k", text: "x", source: "channel" });
  assert.equal(h.pendingInputs().length, 1);
});

test("accept fails when state cannot be written", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  h.onStateChange = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(h.accept({ sessionKey: "k", text: "x", source: "channel" }), /disk full/);
});

test("harness snapshot/restore keeps heartbeat, loop, goal, address", () => {
  const h1 = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  const s = h1.state("matrix:!room");
  s.replyTo = { channel: "matrix", target: "!room" };
  s.heartbeat = { prompt: "check", everyMs: 60_000, nextAt: 5, paused: false };
  s.goal = { text: "ship", criteria: ["green"], paused: true, turns: 3 };
  h1.state("bare"); // nothing to persist
  const snap = JSON.parse(JSON.stringify(h1.snapshotSessions()));
  assert.equal(snap.length, 1);

  const h2 = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  h2.restoreSessions(snap);
  const r = h2.state("matrix:!room");
  assert.deepEqual(r.goal, { text: "ship", criteria: ["green"], paused: true, turns: 3 });
  assert.equal(r.heartbeat?.prompt, "check");
  assert.deepEqual(r.replyTo, { channel: "matrix", target: "!room" });
});

test("commands trigger onStateChange", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 1000, busyMode: "queue", log: () => {} });
  let n = 0;
  h.onStateChange = () => {
    n++;
  };
  h.commandHandler = async () => true;
  await h.submit({ sessionKey: "k", text: "/goal x", source: "channel" });
  await new Promise((r) => setImmediate(r));
  assert.equal(n, 1);
});
