import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("explicit task admission never borrows or replaces another operator mandate", async t => {
  const harness = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(() => harness.stop(0));
  let saves = 0;
  harness.onStateChange = async () => { saves++; };
  await harness.accept({ id: "unrelated", sessionKey: "main", source: "channel", text: "Only inspect service A; no changes" });
  await harness.waitForSessionIdle("main");
  const previous = harness.sessions.get("main")!.task;
  const mandate = await harness.operatorTaskMandate("main", "worker-tasks:one", "Implement service B tests only");
  assert.equal(mandate.taskId, "worker-tasks:one");
  assert.equal(mandate.original, "Implement service B tests only");
  assert.equal(mandate.anchor?.task, mandate.original);
  assert.strictEqual(harness.sessions.get("main")!.task, previous);
  assert.notEqual(mandate.taskId, previous?.id);
  assert.deepEqual(await harness.operatorTaskMandate("main", "worker-tasks:one", mandate.original), mandate);
  await assert.rejects(harness.operatorTaskMandate("main", "worker-tasks:one", "Deploy everything"), /unavailable/);
  await assert.rejects(harness.operatorTaskMandate("dispatch:worker", "worker-tasks:one", "task"), /Invalid/);
  assert.ok(saves > 0);
});
