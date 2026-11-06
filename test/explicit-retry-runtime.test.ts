import assert from "node:assert/strict";
import { test } from "node:test";
import { DispatcherRuntime } from "../src/dispatcher-runtime.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";
import { ExecutionStore, type Execution } from "../src/execution.js";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PiSession } from "../src/runtime/pi.js";

test("disk-backed interruption transfers correlated evidence and reuses settled result after another crash", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "recovery-integrated-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const open = async () => { const store = new ExecutionStore(path.join(home, "ledger.json")); await store.load(); return store; };
  let store = await open();
  const task = await store.submit("parent", "request", "Create a PR once", "direct");
  const original = await store.claim(task.id);
  const sourceKey = `dispatch:${task.id}:${original.token}`;
  const intent = `turn:${task.id}:${original.token}`;
  await store.workerSession(task.id, original.token!, sourceKey);
  await store.intent(task.id, original.token!, intent, "unsafe");
  // Receipt is durably present, but execution settlement was interrupted.
  const transcript = [
    { id: "call", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call42", name: "create_pr", arguments: { branch: "fix/once" } }] } },
    { id: "result", type: "message", message: { role: "toolResult", toolCallId: "call42", toolName: "create_pr", isError: false, content: [{ type: "text", text: "Created PR 12" }] } },
  ];
  await writeFile(path.join(home, "transcript.json"), JSON.stringify(transcript));
  store = await open();
  const strategies = new Map([["direct", { version: 1, replaySafe: false, reconcile: true }]]);
  await store.recover(strategies);
  const replacement = await store.claim(task.id, { strategy: "direct", ...strategies.get("direct")! });
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue" });
  const source = await harness.sessionFor(sourceKey);
  const retained = new PiSession({ sessionManager: { getBranch: () => transcript }, subscribe: () => () => {} } as never, {} as never, {});
  transcript.splice(0, transcript.length, ...JSON.parse(await readFile(path.join(home, "transcript.json"), "utf8")));
  source.archiveEntries = () => retained.archiveEntries();
  const target = await harness.sessionFor(`dispatch:${task.id}:${replacement.token}`);
  let handover = "";
  target.seedHandover = async text => { handover = text; };
  const bridge = new DispatcherRuntime(harness, store);
  let admissions = 0;
  harness.accept = async input => {
    admissions++;
    assert.match(handover, /Created PR 12/);
    assert.match(handover, /fix\/once/);
    assert.match(handover, /call42/);
    assert.match(input.text, /never repeat completed effects/);
    await bridge.channel.send(input.replyTo!, "Existing PR 12 retained");
  };
  const context = {
    signal: new AbortController().signal,
    intent: async () => { throw Error("Must retain the interrupted intent"); }, checkpoint: async () => {},
    workerSession: async (key: string) => {
      assert.match(handover, /Created PR 12/);
      await store.workerSession(task.id, replacement.token!, key);
    },
    settleIntent: (key: string, result: string, checkpoint: string) => store.settleIntent(task.id, replacement.token!, key, result, checkpoint),
  };
  assert.equal(await bridge.strategy.execute(replacement, context), "Existing PR 12 retained");
  store = await open();
  await store.recover(strategies);
  const final = await store.claim(task.id, { strategy: "direct", ...strategies.get("direct")! });
  assert.equal(await new DispatcherRuntime(harness, store).strategy.execute(final, context), "Existing PR 12 retained");
  assert.equal(admissions, 1);
  assert.equal(final.intent, undefined);
  assert.equal(final.settledEffect?.result, "Existing PR 12 retained");
});

test("one-claim explicit retry reaches runtime without requiring an absent transcript", async () => {
  let calls = 0;
  let settled = false;
  let bridge: DispatcherRuntime;
  const harness = {
    accept: async (input: { replyTo: { target: string } }) => {
      calls++;
      await bridge.channel.send({ channel: "dispatch", target: input.replyTo.target }, "done");
    },
    reconcileSession: async () => { throw Error("Must not require transcript for explicit retry"); },
  } as unknown as Harness;
  bridge = new DispatcherRuntime(harness, {} as ExecutionStore);
  const task: Execution = { id: "test", parent: "p", requestId: "r", input: "read harmless state", strategy: "direct", strategyVersion: 1,
    token: "fresh", status: "running", restarts: 1, intent: { key: "prior-effect", replay: "unsafe" }, claimedRecoveryAction: "retry" };
  const result = await bridge.strategy.execute(task, {
    signal: new AbortController().signal,
    intent: async () => { throw Error("Existing intent must be retained"); },
    checkpoint: async () => {},
    settleIntent: async () => { settled = true; },
    workerSession: async () => {},
  });
  assert.equal(result, "done"); assert.equal(calls, 1); assert.equal(settled, true);
});

test("default reconciliation transfers completed evidence before admitting replacement work", async () => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue" });
  const source = await harness.sessionFor("dispatch:test:old");
  source.archiveEntries = () => [{ id: "receipt", role: "toolResult", text: "effect already completed: receipt42" }];
  const target = await harness.sessionFor("dispatch:test:fresh");
  let evidence = "";
  target.seedHandover = async text => { evidence = text; };
  const bridge = new DispatcherRuntime(harness, {} as ExecutionStore);
  let calls = 0;
  harness.accept = async input => {
    calls++;
    assert.match(evidence, /receipt42/);
    assert.match(input.text, /never repeat completed effects/);
    await bridge.channel.send(input.replyTo!, "reconciled");
  };
  const task: Execution = { id: "test", parent: "p", requestId: "r", input: "original task", strategy: "direct", strategyVersion: 1,
    token: "fresh", status: "running", restarts: 1, intent: { key: "old-effect", replay: "unsafe" }, recoverySession: "dispatch:test:old" };
  const result = await bridge.strategy.execute(task, {
    signal: new AbortController().signal,
    intent: async () => { throw Error("Must retain interrupted intent"); }, checkpoint: async () => {},
    workerSession: async () => { assert.match(evidence, /receipt42/); }, settleIntent: async () => {},
  });
  assert.equal(result, "reconciled");
  assert.equal(calls, 1);
});
