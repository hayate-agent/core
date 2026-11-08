import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ExecutionContexts } from "../src/execution-contexts.js";
import { PluginHost } from "../src/plugins.js";

test("stream contexts persist before use, stay immutable and inherit through host-owned workers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "hy-contexts-"));
  try {
    const a = path.join(home, "a"), b = path.join(home, "b"); await mkdir(a); await mkdir(b);
    const parent = new Map([["worker", "stream-a"], ["nested", "worker"]]);
    const file = path.join(home, "contexts.json");
    const contexts = new ExecutionContexts(file, home, key => parent.get(key)); await contexts.load();
    await Promise.all([contexts.bind("stream-a", { cwd: a, directories: [b] }), contexts.bind("stream-b", { cwd: b })]);
    assert.equal(contexts.get("stream-a").cwd, a); assert.equal(contexts.get("stream-b").cwd, b);
    assert.deepEqual(contexts.get("nested"), { cwd: a, directories: [a, b] });
    await assert.rejects(contexts.bind("stream-a", { cwd: b }), /immutable/);
    const restored = new ExecutionContexts(file, home, key => parent.get(key)); await restored.load();
    assert.equal(restored.get("worker").cwd, a);
    await restored.capture('nested'); parent.delete('nested');
    assert.equal(restored.get('nested').cwd, a, 'Worker histories retain context after ancestry/claim changes');
    const alias = path.join(home, "alias"); await symlink(a, alias);
    assert.equal((await restored.bind("stream-a", { cwd: alias, directories: [b] })).cwd, a);
    await assert.rejects(restored.bind("bad", { cwd: "relative" }), /Absolute/);
    parent.set("cycle", "cycle"); assert.throws(() => contexts.get("cycle"), /Cyclic/);
    await rm(b, { recursive: true });
    assert.equal((await restored.capture('stream-b')).cwd, b, 'Unavailable checkout does not break global startup');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("trusted backend services are versioned, reusable without a UI and cleared on activation failure/stop", async () => {
  const host = new PluginHost(); let captured: any; let disposed = false;
  const backend = { list: () => ["project"] };
  await host.load([], { home: os.tmpdir(), cwd: os.tmpdir(), agent: "test" }, [], [], [{ apiVersion: 1, activate(api) {
    captured = api;
    api.registerService("workspaces", 1, backend);
    api.onStop(() => { disposed = true; });
  } }]);
  assert.equal(host.services.get("workspaces")?.version, 1);
  assert.equal(host.services.get("workspaces")?.implementation, backend);
  assert.throws(() => captured.registerService("late", 1, {}), /Invalid/);
  await host.stop(); assert.equal(disposed, true); assert.equal(host.services.get("workspaces"), undefined);
  const failed = new PluginHost();
  await assert.rejects(failed.load([], { home: os.tmpdir(), cwd: os.tmpdir(), agent: "test" }, [], [], [{ apiVersion: 1, activate(api) {
    api.registerService("workspaces", 1, backend); api.registerService("workspaces", 1, {});
  } }]), /conflict/);
  assert.equal(failed.services.get("workspaces"), undefined);
});
