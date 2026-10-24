import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { test } from "node:test";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import type { RuntimeSession } from "../src/types.js";

test("context policy validates ordered thresholds", () => {
  assert.equal(contextPolicy().autoHandover, false);
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
  assert.match((await maintenance.boundary("chat", session, async (handover) => { assert.match(handover!.text, /Verified/); rotations++; return next; }))!, /Neue Sitzung übernommen/);
  assert.equal(rotations, 1);
});

test("prepared handover refreshes intervening context after rotation failure", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let summaries = 0;
  const session = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => { summaries++; return "handover"; } } as unknown as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.request("chat", { action: "handover", preserve: "state", resume: "tests" });
  assert.match((await maintenance.boundary("chat", session, async () => { throw new Error("open failed"); }))!, /kein bestätigter Abschluss/);
  const next = { status: () => ({ sessionId: "new" }) } as RuntimeSession;
  assert.match((await new ContextMaintenance(home, () => contextPolicy()).boundary("chat", session, async () => next))!, /Neue Sitzung übernommen/);
  assert.equal(summaries, 2);
});
