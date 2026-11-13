import assert from "node:assert/strict";
import { test } from "node:test";
import { stepCompletionPrompt } from "../src/dispatcher-step-prompt.js";
import { renderCompletionPrompt } from "../src/completion-budget.js";

for (const restricted of [false, true]) test(`verification defect retains ${restricted ? "explicit read-only prohibition" : "original same-deliverable repair scope"}`, () => {
  const task = restricted ? "Read-only verify the integration. Do not modify code or change the separately owned upstream service without approval."
    : "Implement, repair and verify this integration in our owned provider repository. Preserve required CI/review, schema and confidence thresholds; no upstream service changes.";
  const reply = "Verification found that our provider enforces an equality absent from the published API contract. A documented valid example is rejected. I only own verification, so another owner must decide.";
  const input = { id: "owned-verification", sessionKey: "probe:owned-verification", source: "host" as const, text: task,
    completionContext: { recent: [], tasks: [], tools: [{ name: "read", error: false, result: "Authoritative contract example: confidence 0.9; selected probability 0.8. Preserve independent min-confidence checks." }] } };
  const prompt = renderCompletionPrompt(stepCompletionPrompt, input, reply, { task }, Date.now)!;
  assert.ok(prompt); const data = JSON.parse(prompt.slice(prompt.lastIndexOf("DATA: ") + 6));
  assert.equal(data.task, task); assert.equal(data.reply, reply);
  assert.match(prompt, /derived step label such as 'verification'/);
  assert.match(prompt, /SAME owned deliverable/);
  assert.match(prompt, /explicit operator read-only restrictions/);
  assert.match(prompt, /Never weaken a real validated safety\/protocol constraint/);
});
