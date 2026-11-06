import assert from "node:assert/strict";
import { test } from "node:test";
import { OverlayUpdater } from "../src/update.js";

test("update status verifies protection without mutating; apply reports components individually", async () => {
  let verified = 0, skills = 0, cron = 0;
  const updater = new OverlayUpdater(async () => { verified++; }, { skills: async () => { skills++; }, cron: async () => { cron++; throw Error("private path"); } });
  const status = await updater.run("status", ["skills", "cron"]);
  assert.equal(skills + cron, 0); assert.equal(verified, 1);
  assert.ok(status.some(r => r.status === "rollout-required"));
  const applied = await updater.run("apply", ["skills", "cron"]);
  assert.equal(skills, 1); assert.equal(cron, 1);
  assert.equal(applied[0].status, "activated"); assert.equal(applied[1].status, "failed");
  assert.ok(!JSON.stringify(applied).includes("private path"));
});
test("failed protection blocks all activation, queue recovers and serializes updates", async () => {
  let allowed = false, calls = 0;
  const updater = new OverlayUpdater(async () => { if (!allowed) throw Error("integrity"); }, { skills: async () => { calls++; }, cron: async () => {} });
  await assert.rejects(updater.run("apply", ["skills"]), /integrity/); assert.equal(calls, 0);
  allowed = true;
  await Promise.all([updater.run("apply", ["skills", "skills"]), updater.run("apply", ["skills"])]);
  assert.equal(calls, 2);
});
