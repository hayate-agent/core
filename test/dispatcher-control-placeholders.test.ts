import assert from "node:assert/strict";
import { test } from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { dispatcherPlugin } from "../src/builtin-plugins/dispatcher-plugin.js";

test("native full-schema resume accepts only documented empty placeholders, not steering", async () => {
  let tool: any;
  const calls: unknown[][] = [];
  await dispatcherPlugin(() => ({ control: async (...args: unknown[]) => { calls.push(args); } }) as any)
    .activate({ registerTool: (value: any) => { tool = value; }, registerCommand: () => {} } as any);
  const shape = { action: "resume", id: "existing-owner", requestId: "control-shape-v1", task: "", taskId: "", questionId: "", answer: "", decision: "", offset: 0, limit: 1, field: "input", charOffset: 0 };
  const run = (args: object, sessionKey = "parent") => tool.execute(validateToolArguments({ name: tool.name, parameters: tool.parameters } as any, { id: "native-call", name: tool.name, arguments: args } as any), { sessionKey });
  assert.equal(await run(shape), "Control recorded");
  assert.deepEqual(calls, [["parent", "existing-owner", "resume"]]);
  for (const [key, value] of Object.entries({ task: "SOURCE-A only", taskId: "other", questionId: "q", answer: "approve", decision: "continue", field: "decisions", limit: 2, offset: 1, charOffset: 1, unknown: "" })) {
    await assert.rejects(run({ ...shape, [key]: value }), /Control does not accept/);
  }
  await assert.rejects(run(shape, "dispatch:worker"), /Worker delegation/);
  assert.equal(calls.length, 1);
});
