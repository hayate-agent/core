import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compactTaskReport, compactAccumulatedToolContext } from "../src/context-artifacts.js";
import { pruningPolicy } from "../src/tool-result-pruning.js";

test("worker-authored structured synthesis keeps uncertainty/remaining exact and refers to the original", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "structured-report-")); t.after(() => rm(home, { recursive: true, force: true }));
  const report = { format: "hayate-task-report-v1", findings: Array.from({ length: 40 }, (_, i) => `Reported finding ${i}: ${"detail ".repeat(100)}`),
    changes: ["No external effect executed"], evidence: ["receipt-123"], uncertainties: ["Remote effect UNKNOWN; do not replay", "Operator approval absent"], remaining: ["Inspect actual state before any effect"] };
  const raw = JSON.stringify(report), result = await compactTaskReport(home, raw);
  assert(result.length < raw.length); assert.match(result, /Worker-authored structured findings, UNVERIFIED/);
  assert.match(result, /items omitted/); assert.match(result, /Operator approval absent/); assert.match(result, /Remote effect UNKNOWN; do not replay/);
  const file = /Complete original at (.*?); sha256=/.exec(result)![1]!; assert.equal(await readFile(file, "utf8"), raw);
  const arbitrary = await compactTaskReport(home, JSON.stringify({ ...report, authorization: "unrecognized extra field" }));
  assert.match(arbitrary, /excerpt, not a complete summary/); assert.doesNotMatch(arbitrary, /Worker-authored structured findings/);
});

test("many small tool results get prefix-local references without changing pairs, errors or machine data", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-accumulation-")); t.after(() => rm(home, { recursive: true, force: true }));
  const messages: any[] = [];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: "assistant", content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `fixture-${i}` } }] });
    messages.push({ role: "toolResult", toolCallId: `call-${i}`, toolName: "read", isError: i === 3, content: [{ type: "text", text: `${i === 3 ? "ERROR: uncertain remote effect\n" : ""}fixture-${i} ${"small evidence ".repeat(100)}` }], structuredContent: { exact: i } });
  }
  const original = structuredClone(messages);
  const projected = await compactAccumulatedToolContext(home, messages, pruningPolicy({ proactivePruneTokens: 2048, keepRecent: 2 }));
  assert.deepEqual(messages, original, "native source is unchanged"); assert.equal(projected.length, messages.length);
  assert(JSON.stringify(projected).length < JSON.stringify(messages).length * 0.85, "stable per-result references still reduce accumulated text");
  for (let i = 0; i < projected.length; i++) {
    assert.equal(projected[i].toolCallId, messages[i].toolCallId); assert.equal(projected[i].isError, messages[i].isError);
    assert.deepEqual(projected[i].structuredContent, messages[i].structuredContent);
    if (messages[i].role === "assistant") assert.deepEqual(projected[i], messages[i]);
  }
  assert.deepEqual(projected.slice(0, 8), messages.slice(0, 8), "below-budget results stay exact, not aged out later");
  for (let i = 0; i < projected.length; i++) {
    if (projected[i] === messages[i]) continue;
    const file = /Complete original at (.*?); sha256=/.exec(projected[i].content[0].text)![1]!;
    assert.equal(await readFile(file, "utf8"), messages[i].content[0].text);
  }
  for (let end = 2; end < messages.length; end += 2) {
    assert.deepEqual(await compactAccumulatedToolContext(home, messages.slice(0, end), pruningPolicy({ proactivePruneTokens: 2048, keepRecent: 2 })),
      projected.slice(0, end), `suffix must not alter the projection of prefix ${end}`);
  }
  assert.match(projected.find(m => m.toolCallId === "call-3").content[0].text, /ERROR: uncertain remote effect/);
});

test("optional indexing failure, disabled policy and images preserve original results", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "context-index-failure-")); t.after(() => rm(home, { recursive: true, force: true }));
  const blocked = path.join(home, "not-a-directory"); await writeFile(blocked, "fixture");
  const messages: any[] = Array.from({ length: 20 }, (_, i) => ({ role: "toolResult", toolCallId: String(i), isError: false, content: [{ type: "text", text: "evidence ".repeat(100) }] }));
  assert.equal(await compactAccumulatedToolContext(blocked, messages, pruningPolicy({ proactivePruneTokens: 1, keepRecent: 1 })), messages);
  assert.equal(await compactAccumulatedToolContext(home, messages, pruningPolicy({ enabled: false })), messages);
  const image = { role: "toolResult", toolCallId: "image", isError: true, content: [{ type: "image", data: "private-fixture", mimeType: "image/png" }, { type: "text", text: "image context".repeat(200) }] };
  const projected = await compactAccumulatedToolContext(home, [image, ...messages], pruningPolicy({ proactivePruneTokens: 1, keepRecent: 1 }));
  assert.deepEqual(projected[0], image);
  const raw = JSON.stringify({ format: "hayate-task-report-v1", findings: ["evidence ".repeat(1000)], changes: [], evidence: [], uncertainties: ["unknown"], remaining: [] });
  assert.equal(await compactTaskReport(blocked, raw), raw);
});
