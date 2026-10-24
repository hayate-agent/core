import { PermanentDeliveryError } from "../src/types.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalPreview, Harness, NO_REPLY } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

function setup(answer?: (t: string, k: string) => string) {
  const runtime = new FakeRuntime(answer);
  const harness = new Harness({ runtime, tickMs: 60_000, busyMode: "queue", log: () => {} });
  const ch = new MemoryChannel();
  harness.addChannel(ch);
  return { runtime, harness, ch };
}

test("maintenance notices follow the working reply, including silent turns and failures", async () => {
  for (const answer of ["work done", NO_REPLY]) {
    for (const fails of [false, true]) {
      const runtime = new FakeRuntime(() => answer);
      const harness = new Harness({ runtime, tickMs: 60_000, log: () => {}, contextMaintenance: {
        guidance: async () => "",
        boundary: async () => { if (fails) throw Error("private detail"); return "♻️ Kontext kompaktiert."; },
      } });
      const ch = new MemoryChannel(); harness.addChannel(ch);
      await harness.submit(msg("do work"));
      await harness.drained();
      assert.equal(ch.texts().length, 1);
      const text = ch.texts()[0];
      assert.equal(text.startsWith("work done"), answer !== NO_REPLY);
      assert.match(text, fails ? /kein bestätigter Abschluss/ : /Kontext kompaktiert/);
      assert.doesNotMatch(text, /NO_REPLY|private detail/);
      await harness.stop(1000);
    }
  }
});

test("resume reserves session opening against concurrent resumes and inbound turns", async () => {
  const { harness, runtime, ch } = setup();
  const original = runtime.open.bind(runtime);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  runtime.open = async (key, options) => { await gate; return original(key, options); };
  const switching = harness.resumeSession("mem:room1", "chosen");
  await assert.rejects(harness.resumeSession("mem:room1", "another"), /active or queued/);
  const input = harness.submit(msg("during resume"));
  release();
  await switching;
  await input;
  await harness.drained();
  assert.deepEqual(ch.texts(), ["echo: during resume"]);
  await harness.stop(1000);
});

test("hung channels share a single bounded shutdown deadline", async () => {
  const {harness,ch} = setup();
  await harness.submit(msg("hello"));
  await harness.drained();
  ch.stop = async () => new Promise<void>(() => {});
  harness.addChannel({name:"hung-second",async start(){},async send(){},async stop(){await new Promise<void>(()=>{});}});
  const started = Date.now();
  await Promise.race([harness.stop(30),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(Error("shutdown exceeded limit")),500);timer.unref();})]);
  assert.ok(Date.now()-started<500);
});

test("stuck asynchronous session cleanup cannot block channel shutdown", async () => {
  const { harness, ch } = setup();
  await harness.submit(msg("hello"));
  await harness.drained();
  const state = [...harness.sessions.values()][0];
  state.session!.dispose = () => new Promise<void>(() => {});
  let stopped = false;
  ch.stop = async () => { stopped = true; };
  const deadline = new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("shutdown hung")), 1000); timer.unref(); });
  await Promise.race([harness.stop(20), deadline]);
  assert.equal(stopped, true);
});

test("async gateway initialization orders telemetry without blocking durable replies", async () => {
  const {harness,ch,runtime} = setup();
  const open = runtime.open.bind(runtime);
  runtime.open = async (key,options) => {
    const session = await open(key,options);
    const prompt = session.prompt.bind(session);
    session.prompt = async (text, opts) => {
      for (let i=0;i<60;i++) opts?.onEvent?.({type:"text",delta:"x"});
      opts?.onEvent?.({type:"tool",phase:"start",name:"bash"});
      opts?.onEvent?.({type:"tool",phase:"end",name:"bash"});
      opts?.onEvent?.({type:"usage",input:1,output:1,cacheRead:0,cacheWrite:0,costUsd:0});
      return prompt(text,opts);
    };
    return session;
  };
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release=resolve;});
  const order: string[] = [];
  const channel = ch as import("../src/types.js").Channel;
  channel.turnStatus = async (_to,_input,status) => {
    if (status === "started") {await gate; order.push("started");}
    else order.push(status);
  };
  channel.turnEvent = (_to,event) => {order.push(event.type);};
  await harness.submit(msg("hello"));
  await harness.drained();
  assert.deepEqual(ch.texts(),["echo: hello"]);
  assert.deepEqual(order,[]);
  release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(order,["started",...Array(60).fill("text"),"tool","tool","usage","text","completed"]);
  await harness.stop(1000);
});

test("messages are processed in order and replies delivered", async () => {
  const { harness, ch } = setup();
  await harness.submit(msg("one"));
  await harness.submit(msg("two"));
  await harness.drained();
  assert.deepEqual(ch.texts(), ["echo: one", "echo: two"]);
});

test("one runtime session per session key, resumed", async () => {
  const { harness, runtime } = setup();
  await harness.submit(msg("a", "@x", "k1"));
  await harness.submit(msg("b", "@x", "k1"));
  await harness.submit(msg("c", "@x", "k2"));
  await harness.drained();
  assert.deepEqual(runtime.opened, [
    { key: "k1", fresh: false },
    { key: "k2", fresh: false },
  ]);
});

test("reply-optional input gets the NO_REPLY hint", async () => {
  const { harness, runtime } = setup(() => NO_REPLY);
  await harness.submit({ ...msg("Build ist rot"), replyOptional: true });
  await harness.drained();
  assert.match(runtime.sessions.get("mem:room1")!.prompts[0], /^Build ist rot\n\n\(Not addressed to you[\s\S]*NO_REPLY/);
});

test("NO_REPLY stays silent", async () => {
  const { harness, ch } = setup(() => NO_REPLY);
  await harness.submit(msg("hi"));
  await harness.drained();
  assert.deepEqual(ch.sent, []);
});

test("busy mode steer injects into the running turn", async () => {
  const { harness, runtime } = setup();
  harness.busyMode = "steer";
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.submit(msg("long task"));
  await new Promise((r) => setImmediate(r));
  await harness.submit(msg("also this"));
  release();
  await harness.drained();
  const s = runtime.sessions.get("mem:room1")!;
  assert.deepEqual(s.steered, ["also this"]);
  assert.deepEqual(s.prompts, ["long task"]);
});

test("pause holds the queue, resume continues in order", async () => {
  const { harness, ch } = setup();
  harness.paused = true;
  await harness.submit(msg("one"));
  await harness.submit(msg("two"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ch.sent, []);
  harness.resume();
  await harness.drained();
  assert.deepEqual(ch.texts(), ["echo: one", "echo: two"]);
});

test("tick: heartbeat re-enters idle session when due", async () => {
  const { harness, runtime } = setup(() => NO_REPLY);
  const s = harness.state("mem:room1");
  s.replyTo = { channel: "mem", target: "room1" };
  s.heartbeat = { prompt: "check inbox", everyMs: 60_000, nextAt: 1_000, paused: false };
  await harness.tick(500);
  await harness.drained();
  assert.equal(runtime.sessions.size, 0, "not yet due");
  await harness.tick(1_000);
  await harness.drained();
  assert.match(runtime.sessions.get("mem:room1")!.prompts[0], /^check inbox/);
  assert.equal(s.heartbeat.nextAt, 61_000);
});

test("tick: /loop with --times stops after N runs", async () => {
  const { harness, runtime } = setup();
  const s = harness.state("mem:room1");
  s.replyTo = { channel: "mem", target: "room1" };
  s.loop = { prompt: "ping", everyMs: 10, nextAt: 0, paused: false, remaining: 2 };
  await harness.tick(0);
  await harness.drained();
  await harness.tick(10);
  await harness.drained();
  await harness.tick(20);
  await harness.drained();
  assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 2);
  assert.equal(s.loop, undefined);
});

test("goal continues on ticks until GOAL_DONE", async () => {
  let n = 0;
  const { harness, ch } = setup(() => (++n >= 3 ? "finished GOAL_DONE" : `step ${n}`));
  const s = harness.state("mem:room1");
  s.replyTo = { channel: "mem", target: "room1" };
  s.goal = { text: "ship it", criteria: [], paused: false, turns: 0 };
  for (let i = 0; i < 5; i++) {
    await harness.tick(i);
    await harness.drained();
  }
  assert.equal(s.goal, undefined);
  assert.deepEqual(ch.texts(), ["step 1", "step 2", "finished"]);
});

test("goal pauses when blocked", async () => {
  const { harness, ch } = setup(() => "need a token GOAL_BLOCKED");
  const s = harness.state("mem:room1");
  s.replyTo = { channel: "mem", target: "room1" };
  s.goal = { text: "deploy", criteria: [], paused: false, turns: 0 };
  await harness.tick(0);
  await harness.drained();
  assert.equal(s.goal?.paused, true);
  assert.match(ch.texts()[0], /need a token[\s\S]*Goal paused/);
});

test("runtime errors are reported, loop keeps going", async () => {
  const { harness, ch } = setup((t) => {
    if (t === "boom") throw new Error("model down");
    return `ok ${t}`;
  });
  await harness.submit(msg("boom"));
  await harness.submit(msg("next"));
  await harness.drained();
  assert.deepEqual(ch.texts(), ["⚠️ model down", "ok next"]);
  assert.equal(ch.sent[0]!.meta?.outcome, "failed", "interactive channels receive failure styling metadata too");
  assert.equal(ch.sent[1]!.meta?.outcome, undefined);
});

test("steered input stays in the inbox until the turn finishes", async () => {
  const { harness, runtime } = setup();
  harness.busyMode = "steer";
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.submit(msg("long task"));
  await new Promise((r) => setImmediate(r));
  await harness.submit(msg("also this"));
  assert.deepEqual(harness.pendingInputs().map((i) => i.text), ["long task", "also this"]);
  release();
  await harness.drained();
  assert.deepEqual(harness.pendingInputs(), []);
});

test("steered channel input reaches the runtime only after it is durable", async () => {
  const { harness, runtime } = setup();
  harness.busyMode = "steer";
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.submit(msg("long task"));
  await new Promise((r) => setImmediate(r));
  harness.onStateChange = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(harness.accept({ ...msg("also this"), id: "$s1" }), /disk full/);
  assert.deepEqual(runtime.sessions.get("mem:room1")!.steered, []);
  assert.deepEqual(harness.pendingInputs().map((i) => i.text), ["long task"]);
  harness.onStateChange = async () => {};
  release();
  await harness.drained();
});

test("steered input arriving as the turn ends becomes the next turn", async () => {
  const { harness, runtime } = setup();
  harness.busyMode = "steer";
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.submit(msg("long task"));
  await new Promise((r) => setImmediate(r));
  let persist!: () => void;
  let blocked = true;
  harness.onStateChange = () => (blocked ? new Promise<void>((r) => (persist = r)) : undefined);
  const accepting = harness.accept({ ...msg("late follow-up"), id: "$late" });
  await new Promise((r) => setImmediate(r));
  blocked = false;
  release(); // original prompt finishes while the steering save is pending
  await new Promise((r) => setImmediate(r));
  persist();
  await accepting;
  await harness.drained();
  const s = runtime.sessions.get("mem:room1")!;
  assert.deepEqual(s.steered, []);
  assert.deepEqual(s.prompts, ["long task", "late follow-up"]);
  assert.deepEqual(harness.pendingInputs(), []);
});

test("cron/API input does not start before it is in the saved inbox", async () => {
  const { harness, runtime } = setup();
  let persist!: () => void;
  let snapshot: string[] = [];
  harness.onStateChange = () => {
    snapshot = harness.pendingInputs().map((i) => i.text);
    return new Promise<void>((r) => (persist = r));
  };
  harness.enqueue({ sessionKey: "cron:daily", text: "report", source: "cron" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runtime.sessions.get("cron:daily")?.prompts ?? [], []);
  assert.deepEqual(snapshot, ["report"]);
  harness.onStateChange = async () => {};
  persist();
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("cron:daily")!.prompts, ["report"]);
});

test("steering input is in every snapshot while the turn ends concurrently", async () => {
  const { harness, runtime } = setup();
  harness.busyMode = "steer";
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.submit(msg("long task"));
  await new Promise((r) => setImmediate(r));
  const snapshots: string[][] = [];
  let persist!: () => void;
  let first = true;
  harness.onStateChange = () => {
    snapshots.push(harness.pendingInputs().map((i) => i.text));
    if (first) {
      first = false;
      return new Promise<void>((r) => (persist = r));
    }
  };
  const accepting = harness.accept({ ...msg("follow-up"), id: "$f" });
  await new Promise((r) => setImmediate(r));
  release();
  await new Promise((r) => setTimeout(r, 5));
  persist();
  await accepting;
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["long task", "follow-up"]);
  // Every snapshot up to its completion contains the follow-up; afterwards the inbox is empty.
  const firstEmpty = snapshots.findIndex((snap) => !snap.includes("follow-up"));
  assert.ok(firstEmpty > 0, JSON.stringify(snapshots));
  for (const snap of snapshots.slice(firstEmpty)) assert.deepEqual(snap, [], JSON.stringify(snapshots));
});

test("a failing steer() falls back to the next turn instead of failing acceptance", async () => {
  const { harness, runtime } = setup();
  harness.busyMode = "steer";
  await harness.sessionFor("mem:room1");
  const fake = runtime.sessions.get("mem:room1")!;
  const release = fake.hold();
  fake.steer = async () => {
    throw new Error("runtime refused");
  };
  await harness.submit(msg("long task"));
  await new Promise((r) => setImmediate(r));
  await harness.accept({ ...msg("follow-up"), id: "$f2" });
  assert.deepEqual(harness.pendingInputs().map((i) => i.text), ["long task", "follow-up"]);
  release();
  await harness.drained();
  assert.deepEqual(fake.prompts, ["long task", "follow-up"]);
  await harness.accept({ ...msg("follow-up"), id: "$f2" }); // redelivery is deduplicated
  await harness.drained();
  assert.deepEqual(fake.prompts, ["long task", "follow-up"]);
});

test("submit() of an API input does not run before its inbox save", async () => {
  const { harness, runtime } = setup();
  let persist!: () => void;
  harness.onStateChange = () => new Promise<void>((r) => (persist = r));
  await harness.submit({ sessionKey: "api:x", text: "do it", source: "api" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(runtime.sessions.get("api:x")?.prompts ?? [], []);
  harness.onStateChange = async () => {};
  persist();
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("api:x")!.prompts, ["do it"]);
});

test("a permanently rejected reply is parked and the session continues", async () => {
  const parked: string[] = [];
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60_000, busyMode: "queue", log: () => {}, parkUndeliverable: async (e) => void parked.push(e.text) });
  const ch = new MemoryChannel();
  harness.addChannel(ch);
  let reject = true;
  const realSend = ch.send.bind(ch);
  ch.send = async (to, text) => {
    if (reject) {
      reject = false;
      throw new PermanentDeliveryError("HTTP 403");
    }
    return realSend(to, text);
  };
  await harness.submit(msg("eins"));
  await harness.drained();
  await harness.submit(msg("zwei"));
  await harness.drained();
  assert.equal(parked.length, 1);
  assert.equal(ch.texts().length, 1);
  assert.equal(harness.outboxEntries().length, 0);
});

test("completion-save failure does not re-run the turn; reply waits until saved", async () => {
  const { harness, runtime, ch } = setup();
  let fail = true;
  harness.onStateChange = async () => {
    if (fail) throw new Error("disk full");
  };
  await harness.submit(msg("one"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ch.texts(), []); // not sent before the transition is durable
  fail = false;
  harness.enqueue(msg("two"));
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["one", "two"]);
  assert.deepEqual(ch.texts(), ["echo: one", "echo: two"]);
});

test("failed reply stays in the outbox and is resent before later input, turn not re-run", async () => {
  const { harness, runtime, ch } = setup();
  harness.onStateChange = async () => {};
  const send = ch.send.bind(ch);
  let fail = true;
  ch.send = async (to, text) => {
    if (fail) {
      fail = false;
      throw new Error("homeserver unavailable");
    }
    await send(to, text);
  };

  await harness.submit(msg("one"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(harness.pendingInputs(), []);
  assert.deepEqual(harness.outboxEntries().map((e) => e.text), ["echo: one"]);

  harness.enqueue(msg("two"));
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["one", "two"]);
  assert.deepEqual(ch.texts(), ["echo: one", "echo: two"]);
  assert.deepEqual(harness.outboxEntries(), []);
});

test("tick retries a failed reply without further input", async () => {
  const { harness, runtime, ch } = setup();
  const send = ch.send.bind(ch);
  let fail = true;
  ch.send = async (to, text) => {
    if (fail) throw new Error("homeserver unavailable");
    await send(to, text);
  };
  await harness.submit(msg("one"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ch.texts(), []);
  fail = false;
  await harness.tick();
  await harness.drained();
  assert.deepEqual(ch.texts(), ["echo: one"]);
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["one"]);
});

test("restored outbox is delivered after release without running a turn", async () => {
  const { harness, runtime, ch } = setup();
  harness.restoreOutbox([{ sessionKey: "mem:room1", to: ROOM, text: "late reply" }]);
  harness.enqueue(msg("startup"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ch.texts(), []); // held until channels are up
  harness.releaseRestored();
  await harness.drained();
  assert.deepEqual(ch.texts(), ["late reply", "echo: startup"]);
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["startup"]);
});

test("accepted channel input is persisted before its turn starts", async () => {
  const { harness, runtime } = setup();
  let release!: () => void;
  const saved = new Promise<void>((resolve) => (release = resolve));
  harness.onStateChange = () => saved;
  const accepted = harness.accept({ ...msg("durable first"), id: "$durable" });
  await new Promise((r) => setImmediate(r));
  assert.equal(runtime.sessions.size, 0);
  assert.deepEqual(harness.pendingInputs().map((input) => input.text), ["durable first"]);
  release();
  await accepted;
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["durable first"]);
});

test("approval previews never include arbitrary argument values", () => {
  const secret = "unrecognized-credential-value";
  const preview = approvalPreview("bash", { command: `deploy --credential ${secret}`, cwd: "/private/project" });
  assert.equal(preview, "shell action: custom command; arguments hidden");
  assert.ok(!preview.includes(secret));
  assert.ok(!preview.includes("/private/project"));
  assert.equal(approvalPreview("write", { path: "src/config.ts", content: secret }), 'path: "src/config.ts"');
});

// ---------------------------------------------------------------- API runs (per-turn options)

function apiRun(id: string, text: string, sessionKey = "api:s1"): import("../src/types.js").Inbound {
  return {
    id,
    sessionKey,
    text,
    source: "api",
    replyTo: { channel: "mem", target: id },
    turn: { instructions: "be terse", model: "p/m", thinking: "high" },
  };
}

test("API run: turn options reach the runtime, events reach the channel, result always delivered", async () => {
  const { harness, runtime, ch } = setup(() => NO_REPLY);
  ch.streams = true;
  await harness.accept(apiRun("r1", "do it"));
  await harness.drained();
  const s = runtime.sessions.get("api:s1")!;
  assert.equal(s.options[0].instructions, "be terse");
  assert.equal(s.options[0].model, "p/m");
  assert.equal(s.options[0].thinking, "high");
  assert.deepEqual(ch.events.map((e) => [e.to.target, e.event.type]), [["r1", "text"]]);
  // NO_REPLY still finishes the run (empty result), and the run address is not the session's.
  assert.deepEqual(ch.sent.map((x) => [x.to.target, x.text, x.meta?.outcome]), [["r1", "", undefined]]);
  assert.equal(harness.state("api:s1").replyTo, undefined);
});

test("API run: runtime failure is delivered with outcome failed", async () => {
  const { harness, ch } = setup(() => {
    throw new Error("model down");
  });
  await harness.accept(apiRun("r1", "x"));
  await harness.drained();
  assert.equal(ch.sent[0].meta?.outcome, "failed");
  assert.match(ch.sent[0].text, /model down/);
});

test("cancel: queued run is answered as cancelled and never runs", async () => {
  const { harness, runtime, ch } = setup();
  await harness.sessionFor("api:s1");
  const release = runtime.sessions.get("api:s1")!.hold();
  await harness.accept(apiRun("r1", "first"));
  await harness.accept(apiRun("r2", "second"));
  assert.equal(await harness.cancel("api:s1", "r2"), "queued");
  release();
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("api:s1")!.prompts, ["first"]);
  assert.deepEqual(ch.sent.map((x) => [x.to.target, x.meta?.outcome]), [["r2", "cancelled"], ["r1", undefined]]);
  assert.deepEqual(harness.pendingInputs(), []);
});

test("cancel: running run is aborted and finishes as cancelled; unknown id is false", async () => {
  const { harness, runtime, ch } = setup();
  await harness.sessionFor("api:s1");
  runtime.sessions.get("api:s1")!.hold();
  await harness.accept(apiRun("r1", "long"));
  await new Promise((r) => setImmediate(r));
  assert.equal(await harness.cancel("api:s1", "nope"), false);
  assert.equal(await harness.cancel("api:s1", "r1"), "running");
  await harness.drained();
  assert.equal(runtime.sessions.get("api:s1")!.aborted, 1);
  assert.deepEqual(ch.sent.map((x) => [x.to.target, x.meta?.outcome]), [["r1", "cancelled"]]);
});

test("cancel: run stopped while its runtime session is still opening never starts", async () => {
  const { harness, runtime, ch } = setup();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const open = runtime.open.bind(runtime);
  runtime.open = async (key, options) => {
    await gate;
    return open(key, options);
  };
  await harness.accept(apiRun("r1", "work"));
  await new Promise((r) => setImmediate(r));
  assert.equal(await harness.cancel("api:s1", "r1"), "running");
  release();
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("api:s1")!.prompts, []);
  assert.deepEqual(ch.sent.map((x) => [x.to.target, x.text, x.meta?.outcome]), [["r1", "", "cancelled"]]);
});

test("restored input that keeps getting interrupted is given up with a failed reply", async () => {
  const { harness, runtime, ch } = setup();
  const input = { ...msg("build everything"), started: true, replays: 3 };
  const queued = { ...msg("next"), replays: 3 }; // never ran in the crashed process: not charged
  harness.restorePending([input, queued]);
  assert.equal(input.replays, 4);
  assert.equal(queued.replays, 3);
  harness.releaseRestored();
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["next"]);
  assert.equal(ch.sent[0]!.meta?.outcome, "failed");
  assert.match(ch.sent[0]!.text, /interrupted 4 times/);
  assert.deepEqual(ch.texts().slice(1), ["echo: next"]);
});

test("a running turn is marked started durably; restore charges only that input", async () => {
  const { harness, runtime } = setup();
  const saves: Array<Array<{ text: string; started?: boolean }>> = [];
  harness.onStateChange = async () => void saves.push(harness.pendingInputs().map((i) => ({ text: i.text, started: i.started })));
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.submit(msg("crashes"));
  await harness.submit(msg("waits"));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(saves.at(-1), [{ text: "crashes", started: true }, { text: "waits", started: undefined }]);
  // Simulated crash: what was saved last is restored into a fresh harness.
  const restored = harness.pendingInputs().map((i) => structuredClone(i));
  release();
  await harness.drained();
  const next = setup();
  next.harness.restorePending(restored);
  assert.deepEqual(restored.map((i) => [i.text, i.replays, i.started]), [["crashes", 1, undefined], ["waits", undefined, undefined]]);
  next.harness.releaseRestored();
  await next.harness.drained();
  assert.deepEqual(next.ch.texts(), ["echo: crashes", "echo: waits"]);
});

test("a turn does not start while its start checkpoint cannot be saved", async () => {
  const { harness, runtime } = setup();
  let fail = true;
  await harness.submit(msg("careful"));
  harness.onStateChange = async () => {
    if (fail) throw new Error("disk full");
  };
  await harness.submit(msg("careful"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(runtime.sessions.get("mem:room1")?.prompts ?? [], ["careful"]);
  assert.deepEqual(harness.pendingInputs().map((i) => [i.text, i.started]), [["careful", undefined]]);
  fail = false;
  await harness.tick();
  await harness.drained();
  assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["careful", "careful"]);
});
