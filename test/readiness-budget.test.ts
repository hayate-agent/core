import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCompletion } from "../src/completion-check.js";
import { readyStepPrompt } from "../src/dispatcher-step-prompt.js";
import { COMPLETION_PROMPT_LIMIT, fitsCompletionPrompt } from "../src/completion-budget.js";
import type { Inbound } from "../src/types.js";

test("large readiness evidence is projectable so the independent reviewer is actually called", async () => {
  const task = "Original operator mandate: repair and publish source only; preserve all required CI, no live operations. "+"scope ".repeat(500);
  const decisions = [{ requestId: "current", text: "Keep source scope, unknown effects and live prohibition. "+"context ".repeat(400) }];
  const candidates = [{ number: 5, task: "Reconcile and finish existing source integration", role: "high", evidence: "Actual exact-head CI and publication receipts, never repeat completed effects" }];
  const outcomes = Array.from({ length: 3 }, () => ({ result: "verified source milestone "+"x".repeat(7950) }));
  const evidence = Array.from({ length: 36 }, () => ({ name: "bash", error: false, call: "q".repeat(400), result: "\\\"😀".repeat(200) }));
  const reply = "Existing live gate still missing; source is separate. "+"detail ".repeat(1100);
  const data = { task, decisions, outcomes, blocked: { step: { task: "live verification", evidence: "live receipt" }, reply, evidence }, candidates };
  const input: Inbound = { id: "readiness", source: "host", sessionKey: "dispatch:existing", text: task,
    completionContext: { recent: [], tasks: [], tools: evidence, retained: { original: task, technical: {}, workers: { provenance: "host-execution-store", omitted: 0, unassociated: 0,
      items: outcomes.map((o, n) => ({ id: `step:${n}`, requestId: `step:${n}`, status: "completed", restarts: 0, result: o.result })) } } } };
  const original = JSON.stringify(input);
  const prompt = readyStepPrompt(data); assert.ok(!fitsCompletionPrompt(prompt(input, reply, { task }, Date.now)), "reproduces actual oversized host readiness context");
  let calls = 0;
  const result = await assessCompletion({ review: async text => {
    calls++; assert.ok(Buffer.byteLength(text) <= COMPLETION_PROMPT_LIMIT);
    const parsed = JSON.parse(text.slice(text.lastIndexOf("DATA: ") + 6));
    assert.equal(parsed.task, task); assert.deepEqual(parsed.decisions, decisions); assert.deepEqual(parsed.candidates, candidates);
    assert.equal(parsed.projection.incomplete, true); assert.ok(parsed.projection.omittedTools > 0);
    return '{"state":"continue","next":"5"}';
  } }, input, reply, { task }, new AbortController().signal, "p/validator", Date.now, prompt);
  assert.equal(calls, 1, "oversized captured data must not silently prevent all independent assessment");
  assert.equal(result?.state, "continue"); assert.equal(result?.next, "5");
  assert.equal(JSON.stringify(input), original, "only model-context projection, never mutate retained evidence");
});

test("readiness projection never shortens original authority to force admission", async () => {
  const task = "No deployment without original required approval. ".repeat(2000); let calls = 0;
  const result = await assessCompletion({ review: async () => { calls++; return '{"state":"continue","next":"2"}'; } },
    { id: "large-authority", source: "host", sessionKey: "dispatch:existing", text: task }, "held", { task }, new AbortController().signal,
    "p/validator", Date.now, readyStepPrompt({ task, decisions: [], blocked: { step: "approval" }, candidates: [{ number: 2, task: "deploy" }] }));
  assert.equal(calls, 0); assert.equal(result, undefined, "fail closed when exact authority itself cannot fit");
});
