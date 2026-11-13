import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchPlanHistoryPlugin } from "../src/dispatch-plan-history-plugin.js";
import type { PluginAPI, PluginTool } from "../src/plugins.js";
import type { Dispatcher } from "../src/dispatcher.js";

test("history retrieval is bounded and scoped to parent or exact currently owned worker", async () => {
  let tool!: PluginTool; const head = "a".repeat(64), calls: string[] = [];
  const record = { reference: { head, completed: 5, segments: 1 }, steps: [{ outcome: { result: "x".repeat(9000) } }] };
  const task = { id: "owner", parent: "parent", status: "running", token: "current", parentStopped: false };
  const dispatcher = { store: { list: () => [task], readPlanHistory: async (parent: string, id: string, digest: string) => { calls.push(`${parent}:${id}:${digest}`); return record; } } } as unknown as Dispatcher;
  await dispatchPlanHistoryPlugin(() => dispatcher).activate({ registerTool: value => { tool = value; } } as PluginAPI);
  for (const sessionKey of ["parent", "dispatch:owner:current"]) {
    const reply = JSON.parse(await tool.execute({ id: "owner", head }, { sessionKey }) as string);
    assert.equal(reply.text.length, 8000); assert.equal(reply.nextCharOffset, 8000); assert.equal(reply.executionId, "owner");
  }
  for (const sessionKey of ["foreign", "dispatch:other:current", "dispatch:owner:stale", "subagent:owner:current"]) await assert.rejects(tool.execute({ id: "owner", head }, { sessionKey }));
  task.parentStopped = true; await assert.rejects(tool.execute({ id: "owner", head }, { sessionKey: "dispatch:owner:current" }));
  await assert.rejects(tool.execute({ id: "owner", head: "../escape" }, { sessionKey: "parent" }));
  await assert.rejects(tool.execute({ id: "owner", head, charOffset: -1 }, { sessionKey: "parent" }));
  assert.equal(calls.length, 2, "unauthorized or malformed reads never reach the archive");
});
