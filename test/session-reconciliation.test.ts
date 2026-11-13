import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("reconciliation seeds retained results without running a working prompt", async () => {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue" });
  const source = await harness.sessionFor("old");
  const target = await harness.sessionFor("new");
  source.archiveEntries = () => [{ id: "tool1", role: "toolResult", text: "Created PR 12; do not create again" }];
  let evidence = "";
  target.seedHandover = async text => { evidence = text; };
  await harness.reconcileSession("old", "new");
  assert.match(evidence, /Created PR 12/);
  assert.match(evidence, /not new authority/);
  assert.equal(JSON.parse(evidence).sourceKey, "old");
});

test("restart reconciliation reads persisted old worker without reopening its model, tools or MCP", async () => {
  const runtime = new FakeRuntime(), opened: string[] = [];
  const open = runtime.open.bind(runtime); runtime.open = async (key, options) => { opened.push(key); if (key === "old-worker") throw Error("old model/backend unavailable"); return open(key, options); };
  runtime.retainedSessionHistory = async key => { assert.equal(key, "old-worker"); return { sessionId: "original-sdk-id", sessionFile: "/retained/original.jsonl", incomplete: true,
    entries: [{ id: "receipt", role: "toolResult", text: "Already committed change; never repeat" }] }; };
  const h = new Harness({ runtime, tickMs: 60000 }); const target = await h.sessionFor("replacement"); let evidence = "";
  target.seedHandover = async text => { evidence = text; };
  await h.reconcileSession("old-worker", "replacement");
  assert.deepEqual(opened, ["replacement"]); assert.match(evidence, /Already committed change/);
  assert.match(evidence, /original-sdk-id/); assert.match(evidence, /original.jsonl/); assert.match(evidence, /Missing tool outcomes remain unknown/);
});

test("missing persisted old worker is never replaced by an empty newly opened source", async () => {
  const runtime = new FakeRuntime(); let opens = 0;
  runtime.retainedSessionHistory = async () => undefined;
  const open = runtime.open.bind(runtime); runtime.open = async (key, options) => { opens++; return open(key, options); };
  const h = new Harness({ runtime, tickMs: 60000 });
  await assert.rejects(h.reconcileSession("missing-source", "replacement"), /evidence is empty/);
  assert.equal(opens, 0);
});

test("reconciliation does not silently replace absent retained evidence with fresh execution", async () => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue" });
  const source = await harness.sessionFor("old");
  source.archiveEntries = () => [];
  await assert.rejects(harness.reconcileSession("old", "new"), /evidence is empty/);
  await assert.rejects(harness.reconcileSession("old", "old"), /replacement session/);
});
