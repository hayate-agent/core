import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { assessCompletion } from "../src/completion-check.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const verdict of ["blocked", "waiting", "completed", "replace", "exception", "invalid", "undefined", "disabled", "missing"] as const) {
  test(`model continue requires independent admission: ${verdict}`, async () => {
    let h: Harness;
    let turns = 0, checks = 0;
    const runtime = new FakeRuntime(() => {
      if (++turns === 1) h.planContinuation("mem:room1", { state: "continue", next: "MODEL proposal" });
      return "Retained progress";
    });
    h = new Harness({ runtime, tickMs: 60000, ...(verdict === "missing" ? {} : {
      completionCheck: async (input, reply, signal, diagnostic) => {
        checks++;
        if (checks > 1) return { state: "completed" as const };
        if (verdict === "exception") throw Error("adapter failed");
        if (verdict === "undefined") return undefined;
        return assessCompletion({ review: async prompt => {
          assert.ok(prompt.includes("MODEL proposal"));
          assert.ok(prompt.includes("Retained progress"));
          return verdict === "invalid" ? "null" : JSON.stringify(verdict === "replace" ?
            { state: "continue", next: "INDEPENDENT test" } : { state: verdict });
        } }, input, reply, { task: input.completionAnchor!.task }, signal, undefined, Date.now,
        verdict === "disabled" ? undefined : completionPrompt, diagnostic);
      },
    }) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Implement and test the authorized change")); await h.drained();
      assert.equal(turns, verdict === "replace" ? 2 : 1);
      if (verdict === "replace") {
        assert.match(runtime.sessions.get("mem:room1")!.prompts[1], /INDEPENDENT test/);
        assert.doesNotMatch(runtime.sessions.get("mem:room1")!.prompts[1], /MODEL proposal/);
      } else {
        const task = h.snapshotSessions()[0].tasks![0];
        assert.equal(task.state, ["waiting", "completed"].includes(verdict) ? verdict : "blocked");
        if (task.state === "blocked") assert.equal(task.next, "MODEL proposal");
      }
    } finally { await h.stop(0); }
  });
}

test("deployment wait may be replaced by independent test; genuine timed wait remains nonproductive", async () => {
  for (const replace of [false, true]) {
    let h: Harness; let turns = 0;
    const runtime = new FakeRuntime(() => {
      if (++turns === 1) h.planContinuation("mem:room1", { state: "waiting", next: "Check deployment",
        wait: { reason: "Deployment pending", retryAfterMs: 60000, deadline: Date.now() + 180000 } });
      return "Deployment pending, independent tests remain";
    });
    h = new Harness({ runtime, tickMs: 60000, completionCheck: (input, reply, signal) =>
      assessCompletion({ review: async prompt => {
        assert.match(prompt, /Deployment pending/);
        assert.match(prompt, /HOST recorded read call/);
        assert.match(prompt, /HOST recorded test-ready result/);
        return JSON.stringify(turns === 1 ? replace ? { state: "continue", next: "Run independent tests" } : { state: "waiting" } : { state: "completed" });
      } }, input, reply, { task: input.completionAnchor!.task }, signal, undefined, Date.now, completionPrompt) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      const session = await h.sessionFor("mem:room1");
      session.archiveEntries = () => [
        { id: "call", role: "assistant", text: 'HOST recorded read call: {"toolCall":{"id":"read1","name":"read"}}' },
        { id: "result", role: "toolResult", text: 'HOST recorded test-ready result: {"toolCallId":"read1","text":"Independent test is ready"}' },
      ];
      await h.submit(msg("Deploy and test")); await h.drained();
      assert.equal(turns, replace ? 2 : 1);
      if (replace) assert.match(runtime.sessions.get("mem:room1")!.prompts[1], /Run independent tests/);
      else assert.ok(h.snapshotSessions()[0].tasks![0].wait);
    } finally { await h.stop(0); }
  }
});

for (const interrupt of ["cancel", "deadline"] as const) {
  test(`${interrupt} during independent assessment prevents execution`, async () => {
    let h: Harness; let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(r => entered = r), gate = new Promise<void>(r => release = r);
    let now = Date.now(); let turns = 0;
    const runtime = new FakeRuntime(() => {
      turns++; h.planContinuation("mem:room1", { state: "continue", next: "MODEL proposal" }); return "Progress";
    });
    h = new Harness({ runtime, now: () => now, tickMs: 60000, continuationDeadline: () => now + 1000,
      completionCheck: (input, reply, signal) => assessCompletion({ review: async () => {
        entered(); await gate; return '{"state":"continue","next":"Independent work"}';
      } }, input, reply, { task: input.completionAnchor!.task, expiresAt: now + 1000 }, signal, undefined,
      () => now, completionPrompt) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Implement change")); await ready;
      if (interrupt === "cancel") await h.stopConversation("mem:room1"); else now += 2000;
      release(); await h.drained(); assert.equal(turns, 1);
    } finally { release(); await h.stop(0); }
  });
}

test("legacy retained productive next cannot bypass admission after restart", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000 }); h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  h.restoreSessions([{ key: "mem:room1", tasks: [{ id: "legacy", original: "Implement change", state: "active", next: "Old model next", depth: 0 }] }]);
  try {
    await h.recoverTasks(); await h.recoverTasks(); await h.drained();
    assert.equal(runtime.opened.length, 0);
    assert.equal(h.snapshotSessions()[0].tasks![0].state, "blocked");
    assert.equal(h.snapshotSessions()[0].tasks![0].next, "Old model next");
  } finally { await h.stop(0); }
});
