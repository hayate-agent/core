import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import type { Inbound } from "../src/types.js";
import { FakeRuntime, MemoryChannel, ROOM, msg } from "./fakes.js";

const wait = { reason: "worker result", retryAfterMs: 60000, deadline: 900000 };
const plan = { state: "waiting" as const, next: "inspect worker", wait };
const poll = (): Inbound => ({ source: "cron", sessionKey: "mem:room1", text: "poll", taskId: "task", replyTo: ROOM,
  waitRecheck: { reason: wait.reason, next: plan.next } });

test("identical wait retains partial result, approval, blocker and direct answer as chat without routine designation", async () => {
  for (const replyKind of [undefined, "substantive"] as const) {
    for (const text of [
      "Worker A completed: migration dry-run passed with 32 records; worker B is still running.",
      "Approval required before worker B may continue.",
      "Worker B is blocked: credentials are unavailable.",
      "The answer is 32 records.",
    ]) {
      const channel = new MemoryChannel(); Object.assign(channel, { editableProgress: true });
      const h = new Harness({ runtime: new FakeRuntime(() => {
        h.planContinuation("mem:room1", { ...plan, replyKind }); return text;
      }), tickMs: 60000, now: () => 1000 });
      h.addChannel(channel); h.onStateChange = async () => {};
      h.restoreSessions([{ key: "mem:room1", replyTo: ROOM, task: {
        id: "task", original: "Run both authorized workers", state: "waiting", next: plan.next, depth: 0,
        wait: { reason: wait.reason, nextAt: 61000, deadline: wait.deadline },
      } }]);
      try {
        await h.submit(poll()); await h.drained();
        assert.equal(channel.sent.length, 1); assert.equal(channel.sent[0].text, text);
        assert.equal(channel.sent[0].meta?.presentation, undefined);
        assert.equal(h.snapshotSessions()[0].task?.state, "waiting");
      } finally { await h.stop(0); }
    }
  }
});

test("positive routine designation cannot hide changed condition, error, blocker, completion or direct answer", async () => {
  const cases: Array<{ input?: Inbound; plan?: NonNullable<Inbound["continuation"]>; fail?: boolean }> = [
    { plan: { ...plan, replyKind: "routine", wait: { ...wait, reason: "changed condition" } } },
    { plan: { ...plan, replyKind: "routine", next: "changed verification" } },
    { plan: { state: "blocked", replyKind: "routine" } },
    { plan: { state: "completed", replyKind: "routine" } },
    { input: msg("direct question") }, { fail: true },
  ];
  for (const c of cases) {
    const channel = new MemoryChannel(); Object.assign(channel, { editableProgress: true });
    const h = new Harness({ runtime: new FakeRuntime(() => {
      h.planContinuation("mem:room1", c.plan ?? { ...plan, replyKind: "routine" });
      if (c.fail) throw Error("worker probe failed");
      return "attention evidence";
    }), tickMs: 60000, now: () => 1000 });
    h.addChannel(channel); h.onStateChange = async () => {};
    try {
      await h.submit(c.input ?? poll()); await h.drained();
      assert.ok(channel.sent.length); assert.equal(channel.sent.at(-1)?.meta?.presentation, undefined);
    } finally { await h.stop(0); }
  }
});

test("reply designation and text survive persisted outbox failure/restart for routine and substantive replies", async () => {
  for (const replyKind of [undefined, "routine", "substantive"] as const) {
    const channel = new MemoryChannel(); Object.assign(channel, { editableProgress: true });
    const text = replyKind === "routine" ? "unchanged wait" : "Worker A completed: 32 records; B still running";
    const runtime = new FakeRuntime(() => { h.planContinuation("mem:room1", { ...plan, replyKind }); return text; });
    let h = new Harness({ runtime, tickMs: 60000, now: () => 1000 });
    h.addChannel(channel); h.onStateChange = async () => {};
    channel.send = async () => { throw Error("offline"); };
    try {
      await h.submit(poll());
      // drained() intentionally waits for an empty outbox; wait only for settlement here.
      for (let n = 0; n < 100 && !h.outboxEntries().length; n++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const saved = JSON.parse(JSON.stringify(h.snapshotSessions()));
      const outbox = JSON.parse(JSON.stringify(h.outboxEntries()));
      assert.equal(outbox[0].text, text);
      assert.equal(!!outbox[0].statusKey, replyKind === "routine");
      await h.stop(0);
      channel.send = async (to, text, meta) => { channel.sent.push({ to, text, meta }); };
      h = new Harness({ runtime, tickMs: 60000, now: () => 1000 });
      h.addChannel(channel); h.onStateChange = async () => {};
      h.restoreSessions(saved); h.restoreOutbox(outbox);
      await h.start(); h.releaseRestored(); await h.drained();
      assert.equal(channel.sent[0]?.text, text);
      assert.equal(channel.sent[0]?.meta?.presentation, replyKind === "routine" ? "progress" : undefined);
      assert.equal(h.outboxEntries().length, 0);
    } finally { await h.stop(0); }
  }
});
