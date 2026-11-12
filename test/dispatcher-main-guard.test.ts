import assert from "node:assert/strict";
import { test } from "node:test";
import { guardDispatcherMain } from "../src/dispatcher-main-guard.js";
import { toolGuardDenialReason } from "../src/tool-guard-error.js";

for (const tool of ["bash", "write", "edit"]) test(`enabled dispatcher prohibits Main takeover using ${tool}`, () => {
  for (const key of ["matrix:room", "plugin:workspaces:room", "console:main"]) {
    assert.throws(() => guardDispatcherMain(key, tool, true), error => {
      assert.match(toolGuardDenialReason(error), /^dispatcher_required:/); return true;
    });
    assert.doesNotThrow(() => guardDispatcherMain(key, tool, false));
  }
  assert.doesNotThrow(() => guardDispatcherMain("dispatch:execution:token", tool, true));
});

test("Main cannot bypass dispatcher routing by starting a standalone subagent", () => {
  assert.throws(() => guardDispatcherMain("matrix:room", "plugin_subagent", true, { action: "start" }));
  assert.doesNotThrow(() => guardDispatcherMain("matrix:room", "plugin_subagent", true, { action: "result" }));
  assert.throws(() => guardDispatcherMain("improvement:nightly", "bash", true));
});

test("Main retains read/search and dispatcher orchestration", () => {
  for (const tool of ["read", "grep", "find", "ls", "plugin_dispatch", "plugin_task_continuation"])
    assert.doesNotThrow(() => guardDispatcherMain("matrix:room", tool, true));
});
