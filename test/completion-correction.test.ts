import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import type { Inbound } from "../src/types.js";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";

for (const state of ["completed", "stopped"] as const) {
  test(`fresh explicit correction can continue under new authority without reviving ${state} history`, async () => {
    const runtime = new FakeRuntime();
    const observed: Inbound[] = [];
    const request = "Continue implementing the architecture contracts; a child PR is not the whole task";
    const h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => {
      observed.push(input);
      if (input.source !== "channel") return undefined;
      assert.equal(input.completionAnchor?.task, request);
      return assessCompletion({ review: async prompt => {
        const data = JSON.parse(prompt.slice(prompt.indexOf("DATA: ") + 6));
        assert.equal(data.task, request);
        assert.ok(data.context.tasks.some((t: { id: string; state: string }) => t.id === "old" && t.state === state));
        assert.ok(data.context.recent.some((m: { role: string; text: string }) => m.role === "user" && m.text === request));
        assert.match(prompt, /NOT additional authorization/);
        return JSON.stringify({ state: "continue", next: "Test the remaining architecture contract within the fresh request" });
      } }, input, "step finished", { task: input.completionAnchor.task }, new AbortController().signal,
      undefined, Date.now, completionPrompt);
    } });
    runtime.answer = (_text, key) => { h.planContinuation(key, { state: "completed" }); return "step finished"; };
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    h.restoreSessions([{ key: "mem:room1", tasks: [{ id: "old", original: "Implement architecture contracts", state, depth: 0,
      anchor: { id: "old", task: "Implement architecture contracts", receivedAt: 1 } }] }]);
    try {
      await h.submit(msg(request)); await h.drained();
      const tasks = h.snapshotSessions()[0].tasks!;
      assert.equal(tasks.find(t => t.id === "old")!.state, state);
      assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 2);
      assert.equal(observed.length, 2);
      assert.notEqual(observed[0].taskId, "old");
      assert.equal(observed[1].taskId, observed[0].taskId);
      assert.equal(observed[1].completionAnchor?.task, request);
    } finally { await h.stop(0); }
  });
}

test("completion context bounds excerpts and task projection without mutating retained mandates", async () => {
  let observed: Inbound | undefined;
  const h = new Harness({ runtime: new FakeRuntime(() => "a".repeat(4000)), tickMs: 60000,
    completionCheck: async input => { observed = input; return undefined; } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  const original = "o".repeat(4000);
  h.restoreSessions([{ key: "mem:room1", tasks: Array.from({ length: 12 }, (_, i) => ({
    id: `old-${i}`, original, state: "completed", depth: 0, next: "n".repeat(3000),
  })), completionRecent: Array.from({ length: 12 }, (_, i) => ({ role: "user", text: `${i}:` + "x".repeat(4000) })) }]);
  try {
    await h.submit(msg("Continue the explicitly requested remaining work")); await h.drained();
    const context = observed!.completionContext!;
    assert.equal(context.recent.length, 8);
    assert.ok(context.recent.every(m => m.text.length <= 2000));
    assert.equal(context.tasks.length, 8);
    assert.ok(context.tasks.every(t => t.original.length <= 2000 && (t.next?.length ?? 0) <= 1000));
    const snapshot = h.snapshotSessions()[0];
    assert.equal(snapshot.tasks!.find(t => t.id === "old-0")!.original, original);
    assert.equal(snapshot.completionRecent!.length, 8);
    const restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
    try {
      restored.restoreSessions(JSON.parse(JSON.stringify([snapshot])));
      assert.deepEqual(restored.snapshotSessions()[0].completionRecent, snapshot.completionRecent);
    } finally { await restored.stop(0); }
  } finally { await h.stop(0); }
});

test("status question exposes terminal task context without automatically reviving it", async () => {
  let checks = 0;
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => {
    checks++;
    assert.ok(input.completionContext?.tasks.some(t => t.id === "old" && t.state === "completed"));
    return undefined;
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", tasks: [{ id: "old", original: "Implement architecture contracts", state: "completed", depth: 0 }] }]);
  try {
    await h.submit(msg("Is the architecture finished?")); await h.drained();
    assert.equal(checks, 1);
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 1);
    assert.equal(h.snapshotSessions()[0].tasks!.find(t => t.id === "old")!.state, "completed");
  } finally { await h.stop(0); }
});
