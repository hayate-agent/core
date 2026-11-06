import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg, ROOM } from "./fakes.js";

for (const busyMode of ["queue", "steer", "interrupt"] as const) {
  test(`${busyMode}: foreground priority preserves multiple retained task checkpoints`, async () => {
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, busyMode, tickMs: 60000 });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    const tasks = ["one", "two"].map(id => ({ id, original: `mandate ${id}`, state: "waiting" as const, next: `checkpoint ${id}`, depth: 2 }));
    h.restoreSessions([{ key: "mem:room1", tasks, replyTo: ROOM }]);
    h.paused = true;
    try {
      h.enqueue({ id: "background", source: "heartbeat", sessionKey: "mem:room1", text: "background" });
      await h.accept({ ...msg("question"), id: "question" });
      runtime.answer = text => {
        if (text === "question") assert.deepEqual(h.snapshotSessions()[0]!.tasks!.filter(t => t.id === "one" || t.id === "two"), tasks);
        return `echo: ${text}`;
      };
      h.resume(); await h.drained();
      assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["question", "background"]);
      assert.deepEqual(h.snapshotSessions()[0]!.tasks!.filter(t => t.id === "one" || t.id === "two"), tasks);
    } finally { await h.stop(1000); }
  });

  test(`${busyMode}: precomputed cron report finalization queues a separate question`, async () => {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { entered = r; });
    const runtime = new FakeRuntime();
    const h = new Harness({ runtime, busyMode, tickMs: 60000, afterTurn: async (input, reply) => {
      if (input.cronReport) { entered(); await gate; }
      return reply;
    } });
    const ch = new MemoryChannel(); h.addChannel(ch); h.onStateChange = async () => {};
    try {
      await h.accept({ id: "report", source: "cron", sessionKey: "mem:room1", text: "report prompt", replyTo: ROOM,
        cronReport: { job: "job", runId: "run", createdAt: 1, audience: "user", output: "precomputed report" } });
      await ready;
      await h.accept({ ...msg("question"), id: "question" });
      assert.deepEqual(runtime.sessions.get("mem:room1")!.steered, []);
      release(); await h.drained();
      assert.deepEqual(runtime.sessions.get("mem:room1")!.prompts, ["question"]);
      assert.deepEqual(ch.texts(), ["precomputed report", "echo: question"]);
    } finally { release(); await h.stop(1000); }
  });
}
