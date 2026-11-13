import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, chmod, lstat, rm, symlink, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { executionControlPlugin } from "../src/execution-control.js";
import type { PluginAPI } from "../src/plugins.js";

for (const mode of [0o770, 0o2770, 0o755, 0o700]) test(`restart/update after fsGroup remount reseals owned control directory ${mode.toString(8)}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-remount-")); t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, "control"); await mkdir(directory); await chmod(directory, mode);
  const ledger = path.join(home, "executions.json"); await writeFile(ledger, "immutable effect/stop evidence");
  for (let boot = 0; boot < 2; boot++) {
    let stop: (() => Promise<void>) | undefined;
    try {
      await executionControlPlugin(() => undefined, directory).activate({ onStop: (fn: () => Promise<void>) => { stop = fn; } } as unknown as PluginAPI);
      assert.equal((await lstat(directory)).mode & 0o7777, 0o700);
      const pointer = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"));
      assert.equal((await lstat(path.join(directory, pointer.socket))).mode & 0o777, 0o600);
      assert.equal(await readFile(ledger, "utf8"), "immutable effect/stop evidence");
    } finally { await stop?.(); }
    await chmod(directory, mode); // reproduce kubelet reapplying fsGroup before next boot
  }
});

test("symlink control directory is rejected without chmod of its target or endpoint exposure", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-symlink-")); t.after(() => rm(home, { recursive: true, force: true }));
  const target = path.join(home, "target"), link = path.join(home, "control"); await mkdir(target); await chmod(target, 0o755); await symlink(target, link);
  let callbacks = 0;
  await assert.rejects(executionControlPlugin(() => undefined, link).activate({ onStop: () => { callbacks++; } } as unknown as PluginAPI));
  assert.equal((await lstat(target)).mode & 0o777, 0o755); assert.equal(callbacks, 0);
});

test("non-directory control root remains rejected and unmodified", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "control-file-")); t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, "control"); await writeFile(file, "not a control directory");
  await assert.rejects(executionControlPlugin(() => undefined, file).activate({} as PluginAPI));
  assert.equal(await readFile(file, "utf8"), "not a control directory");
});
