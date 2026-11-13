import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchDecisionsPlugin } from "../src/dispatch-decisions-plugin.js";
import type { PluginAPI, PluginTool } from "../src/plugins.js";
import type { Dispatcher } from "../src/dispatcher.js";

test("parent maintenance tool keeps exact conversation binding and typed non-destructive arguments", async () => {
  let tool!: PluginTool; const calls: unknown[][] = [];
  const dispatcher = { store: { list: (parent: string) => parent === "parent" ? [{ id: "same-owner", status: "paused", decisions: [{ requestId: "old", text: "existing context", state: "applied" }] }] : [],
    readDecision: async (...args: unknown[]) => { calls.push(args); return { requestId: "old", text: "exact original", state: "applied" }; } },
    consolidateDecisions: async (...args: unknown[]) => { calls.push(args); return { requestId: "new", state: "pending", revision: 33 }; },
  } as unknown as Dispatcher;
  await dispatchDecisionsPlugin(() => dispatcher).activate({ registerTool: (registered: PluginTool) => { tool = registered; } } as PluginAPI);
  assert.equal(tool.name, "plugin_dispatch_decisions");
  const status = JSON.parse(await tool.execute({ action: "status", id: "same-owner" }, { sessionKey: "parent" }) as string);
  assert.equal(status.revision, 1);
  await tool.execute({ action: "read", id: "same-owner", requestId: "old" }, { sessionKey: "parent" });
  await tool.execute({ action: "consolidate", id: "same-owner", requestId: "new", decision: "Preserve scope and all gates", replaces: ["old"] }, { sessionKey: "parent" });
  assert.deepEqual(calls, [["parent", "same-owner", "old"], ["parent", "same-owner", "new", "Preserve scope and all gates", ["old"], undefined]]);
  for (const sessionKey of ["dispatch:worker", "subagent:worker", "foreign"]) await assert.rejects(tool.execute({ action: "consolidate", id: "same-owner", requestId: "new", decision: "x", replaces: ["old"] }, { sessionKey }));
  await assert.rejects(tool.execute({ action: "consolidate", id: "same-owner", requestId: "new", decision: "x", replaces: [7] }, { sessionKey: "parent" }));
  assert.equal(calls.length, 2, "invalid/foreign requests never reach mutation");
});
