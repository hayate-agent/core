import test from "node:test";
import assert from "node:assert/strict";
import { TurnActivity, type ActivityEvent } from "../src/activity.js";
import { GatewayProgress } from "../src/channels/progress.js";

test("host resource usage reaches native activity and gateway without skill or memory contents", async () => {
  const events: ActivityEvent[] = [], messages: string[] = [];
  const activity = new TurnActivity({ id: "one", role: "main", context: "operator" }, e => events.push(e), { enabled: true, maxAlive: 0 });
  const progress = new GatewayProgress("full", async text => { messages.push(text); });
  for (const e of [{ type: "resource_usage", resource: "skill", action: "loaded", name: "pdf", locale: "de" }, { type: "resource_usage", resource: "memory", action: "recalled", locale: "de" }] as const) { activity.event(e); progress.event(e); }
  progress.event({ type: "tool", phase: "start", name: "mcp__server__query", detail: "PRIVATE MCP ARGS" });
  progress.event({ type: "tool", phase: "end", name: "mcp__server__query", detail: "PRIVATE MCP RESULT" });
  await progress.finish(); activity.finish("completed");
  assert.deepEqual(events.filter(e => e.resource).map(e => e.resource?.kind), ["skill", "memory"]);
  assert.match(messages.join("\n"), /Skill pdf geladen/); assert.match(messages.join("\n"), /Arbeitsgedächtnis/);
  assert.match(messages.join("\n"), /MCP · mcp__server__query/); assert.doesNotMatch(messages.join("\n"), /PRIVATE MCP/);
});
