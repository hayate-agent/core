// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { PluginHost } from "../src/plugins.js";
import { MemoryProviderLifecycle } from "../src/memory-provider-lifecycle.js";
import { Harness } from "../src/harness.js";
import { Scheduler } from "../src/scheduler.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

function setup(extra: Partial<ConstructorParameters<typeof Harness>[0]> = {}) {
  const runtime = new FakeRuntime();
  const harness = new Harness({ runtime, tickMs: 60000, busyMode: "queue", log() {}, ...extra });
  harness.addChannel(new MemoryChannel());
  harness.onStateChange = async () => {};
  return { harness, runtime };
}

test("idle lease fences all ingress before ack; matching release preserves pause", async () => {
  const { harness } = setup();
  harness.paused = true;
  const lease = harness.acquireUpdateAdmission(1000);
  assert.equal(lease.status, "admitted");
  assert.ok(lease.lease_id);
  await assert.rejects(harness.accept({ ...msg("new"), id: "retry" }), /update admission/);
  await assert.rejects(harness.submit(msg("direct")), /update admission/);
  assert.throws(() => harness.enqueue(msg("queued")), /update admission/);
  assert.equal(harness.seenIds().includes("retry"), false);
  assert.equal(harness.releaseUpdateAdmission("wrong"), false);
  assert.equal(harness.acquireUpdateAdmission(1000).status, "leased");
  assert.equal(harness.releaseUpdateAdmission(lease.lease_id!), true);
  assert.equal(harness.paused, true);
  await harness.accept({ ...msg("redelivered"), id: "retry" });
  assert.equal(harness.pendingInputs().length, 1);
  await harness.stop(0);
});

test("busy work is never cancelled or paused to acquire a lease", async () => {
  const { harness, runtime } = setup();
  await harness.sessionFor("mem:room1");
  const release = runtime.sessions.get("mem:room1")!.hold();
  await harness.accept({ ...msg("active"), id: "active" });
  assert.equal(harness.acquireUpdateAdmission(1000).status, "busy");
  assert.equal(harness.stopping, false);
  assert.equal(harness.paused, false);
  release();
  await harness.drained();
  assert.equal(harness.acquireUpdateAdmission(1000).status, "admitted");
  await harness.stop(1000);
});

test("in-flight producers reserve admission across await and lease prevents new scheduler work", async () => {
  const { harness } = setup();
  let finish!: () => void;
  const work = harness.withForegroundWork(async () => new Promise<void>(resolve => { finish = resolve; }));
  assert.equal(harness.acquireUpdateAdmission(1000).status, "busy");
  finish(); await work;
  const lease = harness.acquireUpdateAdmission(1000);
  const scheduler = new Scheduler(harness, { timezone: "UTC" });
  await scheduler.runJob({ name: "fenced", schedule: "* * * * *", prompt: "must not run" });
  assert.equal(harness.pendingInputs().length, 0);
  assert.equal(harness.updateAdmissionStatus().lease_id, lease.lease_id);
  await harness.stop(0);
});

test("expiry is conditional on the same lease and shutdown never reopens admission", async () => {
  let now = 100;
  const { harness } = setup({ now: () => now });
  const old = harness.acquireUpdateAdmission(1000);
  now = 1101;
  assert.equal(harness.updateAdmissionStatus().status, "idle");
  const next = harness.acquireUpdateAdmission(1000);
  assert.notEqual(next.lease_id, old.lease_id);
  assert.equal(harness.releaseUpdateAdmission(old.lease_id!), false);
  await harness.stop(0);
  now = 10000;
  assert.equal(harness.updateAdmissionStatus().status, "unavailable");
  await assert.rejects(harness.accept(msg("late")), /shutting down/);
});

test("queued outbox, approvals and owner blockers are real blockers, not runtime maintenance", async () => {
  let blockers = ["dispatcher work"];
  const { harness } = setup({ updateBlockers: () => blockers });
  assert.deepEqual(harness.acquireUpdateAdmission(1000).blockers, blockers);
  blockers = [];
  harness.restoreOutbox([{ id: "reply", sessionKey: "mem:room1", to: { channel: "mem", target: "room1" }, text: "pending" }]);
  assert.equal(harness.acquireUpdateAdmission(1000).status, "busy");
  await harness.stop(0);
});

test("pending approval alone blocks admission without resolving it", async () => {
  const { harness } = setup();
  let resolved = false;
  harness.approvals.set("approval", { resolve() { resolved = true; } } as never);
  assert.equal(harness.acquireUpdateAdmission(1000).status, "busy");
  assert.equal(resolved, false);
  harness.approvals.clear();
  await harness.stop(0);
});

test("ordinary memory maintenance does not veto idle; existing owner close drains it", async () => {
  const { harness } = setup();
  let release!: () => void;
  let closed = false;
  const maintenance = new Promise<void>(resolve => { release = resolve; });
  const provider = new MemoryProviderLifecycle(async () => ({
    reindex: () => maintenance,
    close: async () => { closed = true; },
  } as never));
  await provider.ensureConnected();
  const indexing = provider.reindex();
  assert.equal(harness.acquireUpdateAdmission(1000).status, "admitted");
  const closing = provider.close();
  await Promise.resolve();
  assert.equal(closed, false);
  release(); await indexing; await closing;
  assert.equal(closed, true);
  await harness.stop(0);
});

test("real scheduler script reserves foreground ownership through output delivery", async () => {
  const { harness } = setup();
  const dir = await mkdtemp(path.join(tmpdir(), "admission-script-"));
  const entered = path.join(dir, "entered"), release = path.join(dir, "release");
  await writeFile(path.join(dir, "job"), `#!/bin/sh\ntouch '${entered}'\nwhile [ ! -e '${release}' ]; do sleep 0.01; done\nprintf 'finished'\n`, { mode: 0o700 });
  const scheduler = new Scheduler(harness, { scriptsDir: dir, timezone: "UTC", log() {} });
  const work = scheduler.runJob({ name: "script", schedule: "* * * * *", script: "job", no_agent: true, deliver: "local" });
  try {
    for (let i = 0; ; i++) {
      try { await access(entered); break; } catch { if (i === 100) throw Error("script not entered"); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(harness.acquireUpdateAdmission(1000).status, "busy");
    await writeFile(release, "");
    await work;
    assert.equal(harness.acquireUpdateAdmission(1000).status, "admitted");
  } finally { await writeFile(release, ""); await work; await harness.stop(0); await rm(dir, { recursive: true, force: true }); }
});

test("external plugin must opt into foreground ownership; cleanup remains ordered shutdown", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "admission-plugin-"));
  try {
    for (const supported of [false, true]) {
      const file = path.join(dir, `${supported}.mjs`);
      await writeFile(file, `export default { apiVersion: 1, ${supported ? 'updateAdmission: "foreground-owned",' : ''} activate(api) { api.onStop(() => {}); } };`);
      const host = new PluginHost();
      await host.load([file], { home: dir, cwd: dir, agent: "test" }, []);
      assert.equal(host.updateBlockers().length, supported ? 0 : 1);
      await host.stop();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
