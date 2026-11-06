// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { pruningPolicy } from "../src/tool-result-pruning.js";
import { pruneToolResults } from "../src/builtin-plugins/tool-result-projector.js";
const policy = pruningPolicy({ proactivePruneTokens: 1, minResultChars: 1000, maxResultChars: 500, keepRecent: 1 });
const tool = (id: string, body: string, extra = {}) => ({ role: "toolResult", toolCallId: id, toolName: "bash", isError: false, content: [{ type: "text", text: body }], ...extra });

test("pruning enabled by default and rejects invalid policy", () => {
  assert.equal(pruningPolicy().enabled, true);
  assert.throws(() => pruningPolicy({ keepRecent: 0 }));
  assert.throws(() => pruningPolicy({ minResultChars: 500, maxResultChars: 600 }));
});
test("projection shortens old results, preserves recent and original transcript", () => {
  const messages = [tool("old", "START" + "x".repeat(6000) + "END"), tool("recent", "r".repeat(6000))];
  const original = JSON.stringify(messages);
  const result = pruneToolResults(messages, policy);
  assert.ok(result[0].content[0].text.length <= 500);
  assert.match(result[0].content[0].text, /START/);
  assert.match(result[0].content[0].text, /END$/);
  assert.equal(result[0].toolCallId, "old");
  assert.equal(result[1], messages[1]);
  assert.equal(JSON.stringify(messages), original);
});
test("exact duplicate results use a digest and reference, changed results do not", () => {
  const body = "same".repeat(2000);
  const result = pruneToolResults([tool("a", body), tool("b", body), tool("c", body + "changed"), tool("d", "latest")], policy);
  assert.match(result[1].content[0].text, /Exact duplicate of toolCallId=a/);
  assert.doesNotMatch(result[2].content[0].text, /Exact duplicate/);
});
test("errors, images, short results and non-tool messages remain untouched", () => {
  const messages = [tool("error", "e".repeat(6000), { isError: true }), tool("image", "text", { content: [{ type: "image", data: "xx" }] }), { role: "user", content: "user" }, tool("short", "short"), tool("last", "last")];
  const result = pruneToolResults(messages, policy);
  assert.equal(result, messages);
});
test("minimum cap bounds metadata and duplicate references even with long IDs", () => {
  const cap = { ...policy, maxResultChars: 256 };
  const id = "call_" + "😀".repeat(500);
  const body = "x".repeat(6000);
  const messages = [tool(id, body), tool("duplicate", body), tool("recent", body)];
  const result = pruneToolResults(messages, cap);
  for (const message of result.slice(0, 2)) {
    const projected = message.content[0].text;
    assert.ok(projected.length <= 256);
    assert.equal(projected.isWellFormed(), true);
    assert.match(projected, /truncated/);
  }
  assert.equal(result[0].toolCallId, id);
  assert.equal(result[2], messages[2]);
  const ordinary = pruneToolResults([tool("call_example_123456789", body), tool("recent", body)], cap);
  assert.ok(ordinary[0].content[0].text.length <= 256);
});

test("disabled or below-budget pruning returns unchanged context", () => {
  const messages = [tool("old", "x".repeat(6000)), tool("new", "new")];
  assert.equal(pruneToolResults(messages, { ...policy, enabled: false }), messages);
  assert.equal(pruneToolResults(messages, { ...policy, proactivePruneTokens: 100000 }), messages);
});
