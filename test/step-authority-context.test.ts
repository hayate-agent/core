import assert from "node:assert/strict";
import { test } from "node:test";
import { parentDecisionContext, stepCompletionPrompt } from "../src/dispatcher-step-prompt.js";

test("parent context retains follow-up scope and monotonic revision instead of flattening a slice restriction", () => {
  const row = { requestId: "source-only-phase", revision: 20, text: "No live effects during THIS repair; original authorized verification remains deferred, not cancelled.",
    followUp: { task: "repair source only", role: "high", reason: "source repair", evidence: "normal merge receipt" } };
  const text = parentDecisionContext([row]); const data = JSON.parse(text.slice(text.lastIndexOf("\n") + 1));
  assert.deepEqual(data, [row]); assert.match(text, /Explicit global restrictions and deferrals remain binding/);
});

test("step review distinguishes safe evidence discovery and cached reports from genuine permission holds", () => {
  const original = "Original operator mandate: verify the remote service through designated configuration; never infer permission to transmit private data.";
  const text = stepCompletionPrompt({ id: "probe", sessionKey: "probe", source: "host", text: original }, "No local process exists; I did not inspect the documented deployment path", { task: original }, Date.now);
  assert.match(text, /FIRST safe authorized information-gathering action/);
  assert.match(text, /SAME cached report is not rechecking/);
  assert.match(text, /explicit operator prohibition prevents even discovery/);
  assert.match(text, /Never invent endpoint\/model\/credentials/);
  assert.equal(JSON.parse(text.slice(text.lastIndexOf("DATA: ") + 6)).task, original);
});
