import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TurnActivity } from "../src/activity.js";
import { NativeActivityDelivery } from "../src/builtin-plugins/native-activity.js";

test("Matrix native activity delivers host skill and memory use and labels MCP without payload", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "resource-matrix-")); t.after(() => rm(home, { recursive: true, force: true }));
  const sent: string[] = []; const to = { channel: "matrix", target: "room" };
  const delivery = new NativeActivityDelivery(path.join(home, "activity.json"), async (_to, _id, text) => { sent.push(text); }, 60000);
  t.after(() => delivery.stop());
  const activity = new TurnActivity({ id: "one", role: "main", context: "operator" }, event => delivery.event(to, event, "input"), { maxAlive: 0 });
  activity.event({ type: "resource_usage", resource: "skill", action: "loaded", name: "pdf", locale: "de" }); await delivery.flush();
  activity.event({ type: "resource_usage", resource: "memory", action: "recalled", locale: "de" }); await delivery.flush();
  activity.event({ type: "tool", phase: "start", name: "mcp__server__query", callId: "x", detail: "secret" }); await delivery.flush();
  assert.match(sent.join("\n"), /Skill pdf geladen/); assert.match(sent.join("\n"), /Arbeitsgedächtnis abgerufen/);
  assert.match(sent.join("\n"), /MCP · mcp__server__query/); assert.doesNotMatch(sent.join("\n"), /secret/);
  activity.finish("completed");
});
