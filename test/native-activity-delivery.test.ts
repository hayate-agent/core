import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeActivityDelivery } from "../src/builtin-plugins/native-activity.js";
import type { ActivityEvent } from "../src/activity.js";
const to = { channel: "matrix", target: "room" };
const event = (state: "started" | "completed"): ActivityEvent => ({ type: "activity", kind: "progress",
  snapshot: { id: "turn", role: "main", context: "operator", phase: "tool", activity: "tool running", tools: [], elapsedMs: 0, inactiveMs: 0 },
  tool: { callId: "call", name: "read", state } });

test("failed native send remains retryable and delivered tool state is committed in order", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-delivery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "activity.json");
  let fail = true, release: (() => void) | undefined;
  const calls: string[] = [];
  const delivery = new NativeActivityDelivery(file, async (_to, _id, text) => {
    calls.push(text);
    if (fail) { fail = false; throw Error("network unavailable"); }
    if (text.endsWith(": started")) await new Promise<void>(resolve => { release = resolve; });
  }, 30000);
  t.after(() => delivery.stop());
  delivery.metadata(to, "task", "running");
  await assert.rejects(delivery.flush(), /network unavailable/);
  await delivery.flush();
  delivery.event(to, event("started"));
  const deadline = Date.now() + 2000;
  while (!release && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(release, "automatic start flush must reach sender");
  delivery.event(to, event("completed"));
  release();
  // Wait for the automatic start flush without enqueuing the newer completion.
  await (delivery as unknown as { chain: Promise<void> }).chain;
  const started = JSON.parse(await readFile(file, "utf8"));
  assert.equal(Object.values(started.calls).length, 1, "queued completion cannot preempt persisted running receipt");
  await delivery.flush();
  const completed = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(completed.calls, {});
  assert.ok(calls.some(text => text.endsWith(": completed")));
});
