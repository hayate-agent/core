// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ContextMaintenance, contextPolicy, MaintenanceError } from "../src/context-maintenance.js";
import type { RuntimeSession } from "../src/types.js";

test("post-compaction unknown usage notice is once per runtime session across restart and delivery retry", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-diagnostics-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const policy = () => contextPolicy();
  let maintenance = new ContextMaintenance(home, policy);
  let percent: number | undefined = 20;
  let id = "old";
  const session = { status: () => ({ sessionId: id, contextPercent: percent }) } as RuntimeSession;
  const rotate = async () => { throw Error("unknown usage must not rotate"); };
  const target = { channel: "matrix", target: "room" };
  const notices: string[] = [];
  await maintenance.guidance("chat", session);
  for (let cycle = 0; cycle < 3; cycle++) {
    percent = 20;
    await maintenance.beforeTurn("chat", session, rotate, target);
    percent = undefined; // PI has no post-compaction assistant usage yet.
    await maintenance.boundary("chat", session, rotate, target);
    assert.equal((await maintenance.status("chat")).observation?.percent, undefined);
    if (cycle === 0) {
      await assert.rejects(maintenance.flushNotices(async () => { throw Error("delivery failed"); }));
    }
    maintenance = new ContextMaintenance(home, policy);
    await maintenance.flushNotices(async n => { notices.push(n.text); });
  }
  assert.equal(notices.length, 1, "known/unknown alternation must not re-arm chat notices");
  assert.match(notices[0], /kein Prozentwert geschätzt/);
  id = "new";
  await maintenance.guidance("chat", session);
  await maintenance.beforeTurn("chat", session, rotate, target);
  await maintenance.flushNotices(async n => { notices.push(n.text); });
  assert.equal(notices.length, 2, "a different runtime session gets its own diagnostic");
});

test("failed maintenance exposes safe stage/code but retains pending intent for verified retry", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-diagnostics-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const policy = () => contextPolicy({ enabled: false, cooldownTurns: 1 });
  let fail = true;
  const session = {
    status: () => ({ sessionId: "old" }),
    compact: async () => { if (fail) throw new MaintenanceError("compact", "timeout"); },
  } as unknown as RuntimeSession;
  const rotate = async () => { throw Error("unexpected rotation"); };
  const maintenance = new ContextMaintenance(home, policy);
  await maintenance.request("chat", { action: "compact", preserve: "verified state", resume: "tests" });
  const notice = await maintenance.boundary("chat", session, rotate);
  assert.match(notice!, /Stufe: compact; Code: timeout/);
  const failed = await maintenance.status("chat");
  assert.equal(failed.pending?.action, "compact");
  assert.equal(failed.failure?.stage, "compact");
  fail = false;
  const restarted = new ContextMaintenance(home, policy);
  assert.match((await restarted.boundary("chat", session, rotate))!, /Kontext kompaktiert/);
  const recovered = await restarted.status("chat");
  assert.equal(recovered.pending, undefined);
  assert.equal(recovered.failure, undefined);
});
