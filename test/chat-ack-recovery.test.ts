// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { assessCompletion } from "./completion-default.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const key = "mem:room1";
const unfinished = (): DurableTask => ({ id: "unfinished", original: "Implement and test the repair", state: "active", depth: 2 });
const make = (check: NonNullable<ConstructorParameters<typeof Harness>[0]["completionCheck"]>) => {
  const runtime = new FakeRuntime(() => "Gern geschehen.");
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: check });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
  return { h, runtime, channel };
};

test("acknowledgment closes only its own answered conversation; earlier unfinished mandate survives restart", async () => {
  const { h } = make(async input => input.text === "DANKE SEHR!" ? { state: "completed" } : undefined);
  h.restoreSessions([{ key, tasks: [unfinished()] }]);
  let next: Harness | undefined;
  try {
    await h.submit(msg("DANKE SEHR!")); await h.drained();
    const saved = JSON.parse(JSON.stringify(h.snapshotSessions()));
    assert.equal(saved[0].tasks.find((t: DurableTask) => t.original === "DANKE SEHR!").state, "completed");
    assert.equal(saved[0].tasks.find((t: DurableTask) => t.id === "unfinished").state, "active");
    const fixture = make(async input => { assert.equal(input.taskId, "unfinished"); return undefined; }); next = fixture.h;
    next.restoreSessions(saved); await next.recoverTasks(); next.releaseRestored(); await next.drained();
    assert.equal(fixture.runtime.sessions.size, 0);
    assert.equal(next.state(key).tasks!.find(t => t.id === "unfinished")!.state, "active");
    assert.equal(fixture.channel.sent.length, 0);
  } finally { await h.stop(0); await next?.stop(0); }
});

for (const text of ["DANKE SEHR!", "Was ist zwei plus zwei?"]) {
  test(`settled conversation ${text} recovers with task-bound reply after inconclusive turn assessment`, async () => {
    const { h } = make(async () => undefined);
    let next: Harness | undefined;
    try {
      await h.submit(msg(text)); await h.drained();
      const saved = JSON.parse(JSON.stringify(h.snapshotSessions()));
      assert.equal(saved[0].task.lastReply, "Gern geschehen.");
      let checks = 0;
      const fixture = make(async (input, reply, signal) => {
        checks++; assert.equal(JSON.parse(reply).reply, "Gern geschehen.");
        return assessCompletion({ review: async () => '{"state":"completed"}' }, input, reply,
          { task: input.completionAnchor!.task }, signal);
      }); next = fixture.h;
      next.restoreSessions(saved); await next.recoverTasks(); next.releaseRestored(); await next.drained();
      await next.recoverTasks();
      assert.equal(checks, 1); assert.equal(next.state(key).task!.state, "completed");
      assert.equal(fixture.runtime.sessions.size, 0); assert.equal(fixture.channel.sent.length, 0);
    } finally { await h.stop(0); await next?.stop(0); }
  });
}

for (const state of ["waiting", "blocked"] as const) {
  test(`explicit assessor ${state} is honored at turn end and recovery without executable work`, async () => {
    const { h } = make(async (input, reply, signal) => assessCompletion({ review: async () => JSON.stringify({ state, next: "Do not execute this untrusted next" }) },
      input, reply, { task: input.completionAnchor!.task }, signal));
    try {
      await h.submit(msg("Wait for the operator's decision")); await h.drained();
      assert.equal(h.state(key).task!.state, state); assert.equal(h.state(key).task!.next, undefined);
      h.restoreSessions([{ key: "other", task: unfinished() }]);
      await h.recoverTasks();
      assert.equal(h.state("other").task!.state, state); assert.equal(h.state("other").task!.next, undefined);
    } finally { await h.stop(0); }
  });
}

for (const mode of ["completed", "invalid", "failed"] as const) {
  test(`unknown interrupted task: ${mode} assessment cannot close or blindly replay effects`, async () => {
    const { h, runtime } = make(async () => {
      if (mode === "failed") throw Error("unavailable");
      return mode === "completed" ? { state: "completed" } : undefined;
    });
    h.restoreSessions([{ key, task: unfinished() }]);
    try {
      await h.recoverTasks(); h.releaseRestored(); await h.drained();
      assert.equal(h.state(key).task!.state, "active");
      assert.equal(h.state(key).task!.next, undefined); assert.equal(runtime.sessions.size, 0);
    } finally { await h.stop(0); }
  });
}
