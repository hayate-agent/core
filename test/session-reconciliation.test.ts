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

test("reconciliation does not silently replace absent retained evidence with fresh execution", async () => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000, busyMode: "queue" });
  const source = await harness.sessionFor("old");
  source.archiveEntries = () => [];
  await assert.rejects(harness.reconcileSession("old", "new"), /evidence is empty/);
  await assert.rejects(harness.reconcileSession("old", "old"), /replacement session/);
});
