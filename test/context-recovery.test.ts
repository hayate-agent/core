import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy, MaintenanceError } from "../src/context-maintenance.js";
import type { RuntimeSession } from "../src/types.js";

for (const action of ["compact", "handover"] as const) test(`${action} failure preserves request across restart and respects failed-attempt cooldown`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-retry-")); t.after(() => rm(home, { recursive: true, force: true }));
  const policy = () => contextPolicy({ enabled: false, cooldownTurns: 2 });
  let fail = true, calls = 0;
  const operation = async () => { calls++; if (fail) throw Error("secret-provider-token"); return "CURRENT STATE AND NEXT STEPS: tests"; };
  const session = { status: () => ({ sessionId: "old", contextPercent: 20 }), compact: operation, summarize: operation, archiveEntries: () => [{ id: "entry", role: "user", text: "preserve history" }] } as unknown as RuntimeSession;
  const rotate = async () => ({ status: () => ({ sessionId: "new" }) }) as RuntimeSession;
  const first = new ContextMaintenance(home, policy);
  const request = { action, preserve: "operator correction", resume: "tests" };
  await first.request("chat", request);
  const run = (m: ContextMaintenance) => action === "handover" ? m.beforeTurn("chat", session, rotate) : m.boundary("chat", session, rotate);
  assert.match((await run(first))!, /kein bestätigter Abschluss/);
  const failed = await first.status("chat");
  assert.deepEqual(failed.pending, request);
  assert.deepEqual(failed.failure, { stage: action === "handover" ? "summary" : "compact", code: "failed", phase: action === "handover" ? "before" : "after", turn: failed.turns, action });
  assert.ok(!JSON.stringify(failed).includes("secret-provider-token"));
  const restarted = new ContextMaintenance(home, policy);
  await run(restarted); assert.equal(calls, 1);
  fail = false;
  if (action === "handover") { await restarted.boundary("chat", session, rotate); await restarted.boundary("chat", session, rotate); }
  assert.match((await run(restarted))!, action === "handover" ? /Neue Sitzung/ : /kompaktiert/);
  assert.equal(calls, 2);
  assert.equal((await restarted.status("chat")).pending, undefined);
  assert.equal((await restarted.status("chat")).failure, undefined);
});

test("archive link failure remains recoverable after rotation and restart", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-link-")); t.after(() => rm(home, { recursive: true, force: true }));
  const policy = () => contextPolicy();
  const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => "checkpoint" } as unknown as RuntimeSession;
  let seeds = 0, rotations = 0;
  const next = { status: () => ({ sessionId: "new" }), seedHandover: async () => { seeds++; } } as unknown as RuntimeSession;
  const maintenance = new ContextMaintenance(home, policy);
  await maintenance.request("chat", { action: "handover", preserve: "state", resume: "wait" });
  maintenance.archives.link = async () => { throw Object.assign(Error("secret storage path"), { code: "ENOSPC" }); };
  await maintenance.beforeTurn("chat", old, async () => { rotations++; return next; });
  const failed = await maintenance.status("chat");
  assert.equal(failed.failure?.stage, "archive-link");
  assert.equal(failed.failure?.code, "ENOSPC");
  assert.equal(failed.handover?.phase, "prepared");
  assert.match((await new ContextMaintenance(home, policy).beforeTurn("chat", next, async () => { throw Error("must not rotate twice"); }))!, /Neue Sitzung/);
  assert.equal(seeds, 1); assert.equal(rotations, 1);
  assert.equal((await maintenance.status("chat")).pending, undefined);
  assert.equal((await maintenance.status("chat")).failure, undefined);
});

test("prepared recovery failures persist safe stage diagnostics without discarding checkpoint", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-refresh-")); t.after(() => rm(home, { recursive: true, force: true }));
  let fail = false;
  const session = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => { if (fail) throw Error("secret"); return "checkpoint"; } } as unknown as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.request("chat", { action: "handover", preserve: "state", resume: "wait" });
  const rotate = async () => { throw Error("cannot rotate"); };
  await maintenance.beforeTurn("chat", session, rotate);
  fail = true;
  await assert.rejects(maintenance.beforeTurn("chat", session, rotate));
  const state = await maintenance.status("chat");
  assert.equal(state.failure?.stage, "summary");
  assert.equal(state.handover?.phase, "prepared");
  assert.ok(state.handover?.archiveId);
});

for (const stage of ["archive", "rotation", "save"] as const) test(`${stage} failure persists bounded diagnostic and recovery data`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-stage-")); t.after(() => rm(home, { recursive: true, force: true }));
  const session = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => "checkpoint" } as unknown as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.request("chat", { action: "handover", preserve: "operator", resume: "next" });
  const failure = () => { throw Object.assign(Error("secret path"), { code: "EIO" }); };
  if (stage === "archive") maintenance.archives.create = failure;
  if (stage === "save") {
    const original = (maintenance as any).save.bind(maintenance);
    let calls = 0;
    (maintenance as any).save = async (...args: any[]) => { if (++calls === 2) throw new MaintenanceError("save", "EIO"); await original(...args); };
  }
  const notice = await maintenance.beforeTurn("chat", session, failure);
  assert.match(notice!, /kein bestätigter Abschluss/);
  const state = await maintenance.status("chat");
  assert.equal(state.failure?.stage, stage);
  assert.equal(state.failure?.code, "EIO");
  assert.ok(state.pending);
  if (stage !== "archive") assert.ok(state.handover?.archiveId);
  assert.ok(!JSON.stringify(state).includes("secret path"));
});

test("assessment failures persist safe diagnostics while work remains eligible later", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-assess-")); t.after(() => rm(home, { recursive: true, force: true }));
  const maintenance = new ContextMaintenance(home, () => contextPolicy(), async () => { throw Error("secret token"); });
  const session = { status: () => ({ sessionId: "old", contextPercent: 80 }) } as RuntimeSession;
  await maintenance.beforeTurn("chat", session, async () => { throw Error("must defer"); });
  const state = await maintenance.status("chat");
  assert.deepEqual(state.assessmentDiagnostic, { stage: "assessment", code: "failed", phase: "before", turn: 0 });
  assert.equal(state.assessmentFailures?.before, 0);
  assert.ok(!JSON.stringify(state).includes("secret token"));
});
