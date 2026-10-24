import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import type { RuntimeSession } from "../src/types.js";

test("slow maintenance serializes its conversation without blocking another conversation", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-parallel-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  const slow = { status: () => ({ sessionId: "slow", contextPercent: 80 }), compact: async () => { entered(); await gate; } } as unknown as RuntimeSession;
  const other = { status: () => ({ sessionId: "other", contextPercent: 0 }) } as RuntimeSession;
  const compacting = maintenance.boundary("slow", slow, async () => { throw Error("unexpected rotation"); });
  await started;
  let sameFinished = false;
  const same = maintenance.request("slow", { action: "compact", preserve: "same", resume: "later" }).then(() => { sameFinished = true; });
  try {
    await Promise.race([
      (async () => {
        await maintenance.guidance("other", other);
        await maintenance.request("other", { action: "compact", preserve: "other", resume: "next" });
        await maintenance.flushNotices(async () => {});
      })(),
      new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error("unrelated conversation blocked")), 1000); timer.unref(); }),
    ]);
    assert.equal(sameFinished, false);
  } finally { release(); await compacting; await same; }
  assert.equal(sameFinished, true);
});

test("context policy validates ordered thresholds", () => {
  assert.equal(contextPolicy().autoHandover, true);
  assert.throws(() => contextPolicy({ compactPercent: 50 }));
  assert.throws(() => contextPolicy({ cooldownTurns: 0 }));
});

test("boundary compacts with preservation instructions and cooldown survives restart", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const summaries: string[] = [];
  const session = { status: () => ({ sessionId: "old", contextPercent: 80 }), compact: async (s: string) => { summaries.push(s); } } as unknown as RuntimeSession;
  const rotate = async () => { throw new Error("unexpected rotate"); };
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.request("chat", { action: "compact", preserve: "PR #22", resume: "run tests" });
  assert.equal(summaries.length, 0, "tool request must not compact during execution");
  assert.equal(await maintenance.boundary("chat", session, rotate), "♻️ Kontext kompaktiert.");
  assert.match(summaries[0], /PR #22/);
  assert.equal(await new ContextMaintenance(home, () => contextPolicy()).boundary("chat", session, rotate), undefined);
  assert.equal(summaries.length, 1);
});

test("completion and durable notice survive restart and failed outbox adoption", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const policy = () => contextPolicy();
  const maintenance = new ContextMaintenance(home, policy);
  let compactions = 0;
  const session = { status: () => ({ sessionId: "old", contextPercent: 80 }), compact: async () => { compactions++; } } as unknown as RuntimeSession;
  const rotate = async () => { throw Error("unexpected"); };
  const target = { channel: "matrix", target: "room" };
  assert.equal(await maintenance.boundary("chat", session, rotate, target), undefined);
  const restarted = new ContextMaintenance(home, policy);
  let id = "";
  await assert.rejects(restarted.flushNotices(async (notice) => { id = notice.id; throw Error("outbox save failed"); }));
  await new ContextMaintenance(home, policy).flushNotices(async (notice) => {
    assert.equal(notice.id, id);
    assert.equal(notice.sessionKey, "chat");
    assert.deepEqual(notice.to, target);
    assert.match(notice.text, /Kontext kompaktiert/);
  });
  await restarted.flushNotices(async () => { assert.fail("already acknowledged"); });
  await restarted.boundary("chat", session, rotate, target);
  assert.equal(compactions, 1);
});

test("unknown usage does not trigger automatic compaction; handover is explicit", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let rotations = 0;
  const session = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => "Verified state; next: tests", compact: async () => { throw new Error("unexpected"); } } as unknown as RuntimeSession;
  const next = { status: () => ({ sessionId: "new" }) } as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.boundary("chat", session, async () => { rotations++; return next; });
  assert.equal(rotations, 0);
  await maintenance.request("chat", { action: "handover", preserve: "state", resume: "tests" });
  assert.match((await maintenance.beforeTurn("chat", session, async (handover) => { assert.match(handover!.text, /Verified/); rotations++; return next; }))!, /Neue Sitzung übernommen/);
  assert.equal(rotations, 1);
});

test("automatic handover runs before work, incoming budget triggers early, compaction stays after", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let percent = 65, rotations = 0, compactions = 0;
  const session = { status: () => ({ sessionId: "old", contextPercent: percent, contextWindow: 1000 }), archiveEntries: () => [], summarize: async () => "checkpoint", compact: async () => { compactions++; } } as unknown as RuntimeSession;
  const next = { status: () => ({ sessionId: "new" }) } as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  const rotate = async () => { rotations++; return next; };
  await maintenance.beforeTurn("chat", session, rotate, undefined, "small");
  assert.equal(rotations, 0);
  await maintenance.beforeTurn("chat", session, rotate, undefined, "x".repeat(600));
  assert.equal(rotations, 1);
  assert.equal(compactions, 0);
  await maintenance.beforeTurn("chat", next, rotate);
  assert.equal(rotations, 1, "no unconditional session churn");
  percent = 95;
  await maintenance.boundary("other", session, rotate);
  assert.equal(compactions, 1);
  assert.equal(rotations, 1, "post-turn cannot rotate even at high usage");
});

test("requested handover waits for pre-turn and explicit checkpoints bypass cooldown", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let rotations = 0;
  const session = { status: () => ({ sessionId: "old", contextPercent: 80 }), compact: async () => {}, archiveEntries: () => [], summarize: async () => "checkpoint" } as unknown as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  const rotate = async () => { rotations++; return { status: () => ({ sessionId: "new" }) } as RuntimeSession; };
  await maintenance.boundary("chat", session, rotate);
  await maintenance.request("chat", { action: "handover", preserve: "done milestone", resume: "new task" });
  await maintenance.boundary("chat", session, rotate);
  assert.equal(rotations, 0);
  assert.equal((await maintenance.load("chat")).pending?.action, "handover");
  await maintenance.beforeTurn("chat", session, rotate);
  assert.equal(rotations, 1);
});

test("prepared handover refreshes intervening context after rotation failure", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let summaries = 0;
  const session = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => { summaries++; return "handover"; } } as unknown as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.request("chat", { action: "handover", preserve: "state", resume: "tests" });
  assert.match((await maintenance.beforeTurn("chat", session, async () => { throw new Error("open failed"); }))!, /kein bestätigter Abschluss/);
  const next = { status: () => ({ sessionId: "new" }) } as RuntimeSession;
  assert.match((await new ContextMaintenance(home, () => contextPolicy()).beforeTurn("chat", session, async () => next))!, /Neue Sitzung übernommen/);
  assert.equal(summaries, 2);
});
