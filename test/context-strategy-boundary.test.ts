import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { FakeRuntime } from "./fakes.js";

test("strategy reservation refuses a direct held assessment and excludes new maintenance until released", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-change-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy, async () => {
    entered(); await gate; return "keep";
  });
  const session = await new FakeRuntime().open("test");
  session.status = () => ({ sessionId: "test", busy: false, contextPercent: 90 });
  const pending = maintenance.boundary("test", session, async () => session);
  try {
    await started;
    await assert.rejects(maintenance.atStrategyBoundary(async () => {}), /Context strategy busy/);
  } finally { release(); await pending; }
  await maintenance.request("test", { action: "handover", preserve: "intent", resume: "next" });
  const before = await maintenance.status("test");
  await maintenance.atStrategyBoundary(async () => {
    await assert.rejects(maintenance.boundary("other", session, async () => session), /Context strategy changing/);
    await assert.rejects(maintenance.atStrategyBoundary(async () => {}), /Context strategy busy/);
  });
  assert.deepEqual(await maintenance.status("test"), before, "strategy selection never migrates pending handover");
  await assert.rejects(maintenance.atStrategyBoundary(async () => { throw Error("save failed"); }), /save failed/);
  await maintenance.atStrategyBoundary(async () => {});
});
