import assert from "node:assert/strict";
import test from "node:test";
import { Harness, type DurableTask } from "../src/harness.js";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const key = "mem:room1";
const task = (): DurableTask => ({ id: "original", original: "Inspect the existing receipt; do not deploy",
  state: "active", depth: 0, next: "Read the existing receipt without changing it",
  lastReply: "I will inspect the existing receipt next." });

for (const restart of [false, true]) test(`idle tick repairs announced-but-unqueued action exactly once (restart=${restart})`, async () => {
  let checks = 0, turns = 0, saved = "", h: Harness;
  const runtime = new FakeRuntime(() => {
    assert.match(saved, /recoveryAdmission/, "admission must cross the persistence barrier before productive work");
    turns++; return "Receipt verified, no deployment performed.";
  });
  const options = { runtime, tickMs: 600000,
    completionCheck: async (...args: Parameters<NonNullable<ConstructorParameters<typeof Harness>[0]["completionCheck"]>>) => {
      checks++;
      return assessCompletion({ review: async prompt => {
        assert.match(prompt, /Inspect the existing receipt/);
        return turns ? '{"state":"completed"}' : '{"state":"continue","next":"Read the existing receipt without changing it"}';
      } }, args[0], args[1], { task: args[0].completionAnchor!.task }, args[2], undefined, undefined, completionPrompt, args[3]);
    } };
  h = new Harness(options); h.addChannel(new MemoryChannel());
  h.onStateChange = async () => { saved = JSON.stringify(h.snapshotSessions()); };
  h.restoreSessions([{ key, task: task() }]);
  try {
    if (restart) {
      saved = JSON.stringify(h.snapshotSessions()); await h.stop(0);
      h = new Harness(options); h.addChannel(new MemoryChannel());
      h.onStateChange = async () => { saved = JSON.stringify(h.snapshotSessions()); };
      h.restoreSessions(JSON.parse(saved));
    }
    await h.tick(); h.releaseRestored(); await h.drained();
    assert.equal(turns, 1); assert.equal(checks, 2);
    assert.equal(h.state(key).task!.state, "completed");
    for (let i = 0; i < 20; i++) { await h.tick(); await h.recoverTasks(); }
    assert.equal(turns, 1); assert.equal(checks, 2, "idle checks do not consume inference after completion");
  } finally { await h.stop(0); }
});

for (const hold of ["pause", "stop", "blocked", "expired"] as const) test(`orphan repair respects ${hold}`, async () => {
  let checks = 0, turns = 0;
  const h = new Harness({ runtime: new FakeRuntime(() => { turns++; return "must not run"; }), tickMs: 600000,
    completionCheck: async () => { checks++; return { state: "continue", next: "read" }; } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  const retained = task();
  if (hold === "blocked") { retained.state = "blocked"; retained.explicitBlocked = true; }
  if (hold === "stop") retained.state = "stopped";
  if (hold === "expired") retained.expiresAt = 1;
  h.restoreSessions([{ key, task: retained }]);
  if (hold === "pause") h.paused = true;
  try { for (let i = 0; i < 10; i++) await h.tick(); assert.equal(checks, 0); assert.equal(turns, 0); }
  finally { await h.stop(0); }
});
