// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { GatewayManager } from "../src/gateway-manager.js";
import { SettingsService } from "../src/settings.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

test("empty gateway composition starts and stops without opening a runtime session or inventing a remote destination", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "zero-gateway-"));
  const runtime = new FakeRuntime(), harness = new Harness({ runtime, tickMs: 60000 });
  t.after(async () => { await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  const settings = new SettingsService(path.join(home, "settings.yaml"), {}); await settings.load();
  const manager = new GatewayManager(harness, settings, { home, agent: "test", approvers: [] }, {});
  await manager.load(); await manager.tick();
  assert.equal(manager.remote, false);
  assert.deepEqual(manager.approvers, []);
  assert.equal(harness.home, undefined);
  assert.equal(harness.channels.size, 0);
  assert.deepEqual(JSON.parse(manager.status()), { active: [], pending: [], errors: {} });
  // Local-channel stand-in: no stdin listener, remote receiver, endpoint or model.
  const local = new MemoryChannel(); harness.addChannel(local);
  await harness.start(); await harness.drained();
  assert.equal(runtime.opened.length, 0);
  assert.deepEqual(local.sent, []);
  await harness.stop(0);
  assert.equal(manager.remote, false);
});
