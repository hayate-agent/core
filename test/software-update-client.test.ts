import test from "node:test";
import assert from "node:assert/strict";
import { softwareLifecyclePlugin } from "../src/software-update-client.js";
import type { PluginAPI, PluginTool } from "../src/plugins.js";

test("fresh update uses the same installation authorization as install", async () => {
  let tool!: PluginTool;
  const calls: string[] = [];
  let allowed = false;
  await softwareLifecyclePlugin(async () => {}, (action, key) => {
    calls.push(`${action}:${key}`); return allowed;
  }).activate({ registerTool: value => { tool = value; } } as PluginAPI);
  for (const action of ["install", "update", "restart"]) {
    await assert.rejects(tool.execute({ action }, { sessionKey: "operator" }), /Operator-authorized maintenance required/);
  }
  assert.deepEqual(calls, ["install:operator", "install:operator", "restart:operator"]);
  calls.length = 0;
  // Read-only status and download-only check do not require installation approval.
  for (const action of ["status", "check"]) await tool.execute({ action }, { sessionKey: "operator" });
  assert.deepEqual(calls, []);
  allowed = true;
  // Without IPC this returns external-owner rather than causing any live update.
  await tool.execute({ action: "update" }, { sessionKey: "operator" });
  assert.deepEqual(calls, ["install:operator"]);
});
