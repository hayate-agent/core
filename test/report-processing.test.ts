// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { PluginHost } from "../src/plugins.js";
import { ReportProcessingRegistry } from "../src/report-processing.js";
import { cronReportPlugin } from "../src/builtin-plugins/cron-report-plugin.js";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

test("report processor selection replaces concrete archive, context and analysis without core policy", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "report-plugin-"));
  const host = new PluginHost(); let customCalls = 0;
  try {
    await host.load([], { home, cwd: home, agent: "test" }, [], [], [cronReportPlugin({ home,
      backend: { analyze: async () => JSON.stringify({ summary: "Retained finding", actions: [] }) }, dispatch: async () => { throw Error("unexpected dispatch"); } }),
      { apiVersion: 1, activate(api) { api.registerReportProcessing("custom", {
        record: async () => { customCalls++; }, context: async () => "custom context", tick: async () => {}, stop: async () => {},
      }); } }]);
    host.reportProcessing.select("cron");
    const input = { source: "cron" as const, sessionKey: "cron:test", text: "Inspect", replyTo: { channel: "mem", target: "room" },
      cronReport: { job: "test", runId: "run", createdAt: 1, audience: "user" as const, original: "Inspect", maxTasks: 0 } };
    await host.reportProcessing.record(input, "Observed issue"); await host.reportProcessing.tick();
    assert.match(await host.reportProcessing.context({ ...input, source: "channel" }), /Retained finding/);
    assert.equal(await host.reportProcessing.context({ ...input, source: "channel", replyTo: { channel: "mem", target: "other" } }), "");
    host.reportProcessing.select("custom"); await host.reportProcessing.record(input, "custom");
    assert.equal(customCalls, 1); assert.equal(await host.reportProcessing.context(input), "custom context");
    await host.stop(); assert.equal(host.reportProcessing.size, 0);
  } finally { await host.stop(); await rm(home, { recursive: true, force: true }); }
});

test("failed activation stops all registered processors once, including when one cleanup fails", async () => {
  const host = new PluginHost(); const stopped: string[] = [];
  const implementation = (name: string) => ({ record: async () => {}, context: async () => "", tick: async () => {}, stop: async () => {
    stopped.push(name); if (name === "broken") throw Error("cleanup failure");
  } });
  await assert.rejects(host.load([], { home: "/tmp", cwd: "/tmp", agent: "test" }, [], [], [{ apiVersion: 1, activate(api) {
    api.registerReportProcessing("first", implementation("first"));
    api.registerReportProcessing("broken", implementation("broken"));
    throw Error("activation failure");
  } }]), /activation failure/);
  assert.deepEqual(stopped, ["broken", "first"]);
  await host.stop(); assert.equal(stopped.length, 2);
});

test("registry validates implementations and fails closed without a selected sink", async () => {
  const registry = new ReportProcessingRegistry();
  await assert.rejects(registry.record({ source: "cron", sessionKey: "cron:x", text: "x" }, "report"), /No report processor/);
  assert.throws(() => registry.register("bad", {} as any), /Invalid/);
  assert.throws(() => registry.select("missing"), /Unknown/);
});
