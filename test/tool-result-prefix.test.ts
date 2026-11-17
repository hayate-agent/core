import assert from "node:assert/strict";
import { test } from "node:test";
import { projectToolResultPrefixes, pruningPolicy } from "../src/tool-result-pruning.js";
import { pruneToolResults } from "../src/builtin-plugins/tool-result-projector.js";

test("strategy budget/age/duplicate changes never rewrite a previously projected prefix", () => {
  const policy = pruningPolicy({ proactivePruneTokens: 2048, minResultChars: 3000, maxResultChars: 1000, keepRecent: 2 });
  const messages: any[] = Array.from({ length: 12 }, (_, i) => ({ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", isError: i === 4,
    structuredContent: { exact: i }, content: [{ type: "text", text: "ERROR: uncertain outcome\n" + "same evidence ".repeat(400) }] }));
  messages.splice(6, 0, { role: "toolResult", toolCallId: "image", content: [{ type: "image", mimeType: "image/png", data: "fixture" }, { type: "text", text: "image context".repeat(1000) }] });
  const original = structuredClone(messages);
  const projected = projectToolResultPrefixes(messages, policy, pruneToolResults);
  assert.deepEqual(messages, original);
  assert.deepEqual(projected[0], messages[0], "first result is below the prefix budget");
  assert.notDeepEqual(projected[2], messages[2], "large qualifying result is immediately shortened");
  assert.match(projected[2].content[0].text, /Exact duplicate of toolCallId=call-0/);
  assert.deepEqual(projected[4], messages[4], "strategy never edits errors");
  assert.deepEqual(projected[6], messages[6], "images stay exact");
  for (let end = 1; end <= messages.length; end++) {
    assert.deepEqual(projectToolResultPrefixes(messages.slice(0, end), policy, pruneToolResults), projected.slice(0, end));
  }
  for (let i = 0; i < messages.length; i++) {
    assert.equal(projected[i].toolCallId, messages[i].toolCallId);
    assert.equal(projected[i].isError, messages[i].isError);
    assert.deepEqual(projected[i].structuredContent, messages[i].structuredContent);
  }
  assert.equal(projectToolResultPrefixes(messages, { ...policy, enabled: false }, pruneToolResults), messages);
});

test("advisory strategy cannot replace call metadata, errors or other messages", () => {
  const messages: any[] = [{ role: "assistant", content: [{ type: "text", text: "exact authority" }] },
    { role: "toolResult", toolCallId: "real", toolName: "read", isError: false, structuredContent: { status: "unknown" }, content: [{ type: "text", text: "evidence".repeat(1000) }] }];
  const projected = projectToolResultPrefixes(messages, pruningPolicy({ proactivePruneTokens: 1 }), ((prefix: any[]) => prefix.map(m =>
    ({ ...m, toolCallId: "wrong", isError: true, structuredContent: {}, content: [{ type: "text", text: "fixture excerpt" }] }))) as any);
  assert.equal(projected[0], messages[0]);
  assert.deepEqual(projected[1], { ...messages[1], content: [{ type: "text", text: "fixture excerpt" }] });
});
