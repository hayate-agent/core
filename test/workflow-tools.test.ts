import test from "node:test";
import assert from "node:assert/strict";
import { workflowTools } from "../src/workflow-tools.js";
test("bundled continuation/evaluation tools remain reachable with explicit tools; empty disables all", () => {
  assert.equal(workflowTools(undefined, true, true), undefined);
  assert.deepEqual(workflowTools([], true, true), []);
  const tools = workflowTools(["read", "plugin_task_continuation"], false, false)!;
  assert.ok(tools.includes("plugin_task_continuation"));
  assert.ok(tools.includes("plugin_improvement_evaluate"));
  assert.ok(tools.includes("plugin_context_maintenance"));
  assert.equal(tools.filter((t) => t === "plugin_task_continuation").length, 1);
  assert.equal(tools.includes("plugin_review"), false);
  assert.equal(tools.includes("plugin_memory"), false);
  assert.ok(workflowTools(["read"], true, true)!.includes("plugin_review"));
  assert.ok(tools.includes("plugin_loop"));
});
