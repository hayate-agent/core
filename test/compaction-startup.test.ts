// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CompactionSelection, type CompactionStrategy } from "../src/compaction.js";
import { PluginHost } from "../src/plugins.js";
import { SettingsService } from "../src/settings.js";
import { compactionStrategyPlugin } from "../src/builtin-plugins/compaction-strategy-plugin.js";
import { Harness } from "../src/harness.js";
import { ContextMaintenance, defaultContextPolicy } from "../src/context-maintenance.js";
import { FakeRuntime } from "./fakes.js";
import { PiSession } from "../src/runtime/pi.js";

test("deferred adapter and command survive plugin registration before startup selection and restored override", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "compaction-startup-"));
  const host = new PluginHost(), h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  t.after(async () => { await h.stop(0); await host.stop(); await rm(home, { recursive: true, force: true }); });
  const file = path.join(home, "settings.yaml");
  let settings = new SettingsService(file, {}); await settings.load(); await settings.setCompactionStrategy("native");
  settings = new SettingsService(file, {}); await settings.load();
  let selection: CompactionSelection | undefined;
  const current = () => { if (!selection) throw Error("Compaction selection not initialized"); return selection; };
  const adapter: CompactionStrategy = { compact: context => current().compact(context) };
  const calls: string[] = [];
  const session = new PiSession({ compact: async (text: string) => { calls.push(text); } } as any, {} as any, {}, undefined, undefined, adapter);
  assert.throws(() => adapter.compact({ compactNative: async () => {} }), /not initialized/);
  const maintenance = new ContextMaintenance(home, () => defaultContextPolicy);
  await host.load([], { home, cwd: home, agent: "test" }, [], [], [
    compactionStrategyPlugin(current, settings, h, maintenance),
    { apiVersion: 1, activate(api) {
      const wrapper = { label: "wrapped", async compact({ compactNative }: Parameters<CompactionStrategy["compact"]>[0]) { await compactNative(this.label); } };
      api.registerCompaction("custom", wrapper);
    } },
  ]);
  selection = new CompactionSelection(host.compactions, "custom");
  await selection.change(settings.snapshot().compactionStrategy, async () => {});
  await session.compact("native call"); assert.deepEqual(calls, ["native call"]);
  await host.commands.get("compaction-strategy")!.run("baseline", {} as any);
  await session.compact(); assert.deepEqual(calls, ["native call", "wrapped"]);
  assert.throws(() => new CompactionSelection(host.compactions, "missing"), /Unknown compaction/);
});
