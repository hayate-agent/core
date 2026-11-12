import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { SessionArchives } from "../src/session-archive.js";
import { resolveCompletionContext } from "../src/completion-context.js";
import { projectObservation } from "../src/completion-budget.js";

test("archive reopen preserves original bytes and envelopes; missing is not successfully empty", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "completion-budget-"));
  try {
    const archives = new SessionArchives(home), key = "conversation";
    assert.equal((await archives.completionEvidence(key, "next")).status, "missing");
    const dir = path.join(home, "session-archives", createHash("sha256").update(key).digest("hex"));
    await mkdir(dir, { recursive: true });
    assert.equal((await archives.completionEvidence(key, "next")).status, "empty");
    const text = JSON.stringify({ type: "assistantBlocks", blocks: [
      { type: "text", text: "latest text" },
      { type: "toolCall", id: "exact-call", name: "write", arguments: { content: "界😀".repeat(60000) } },
    ] });
    const archive = await archives.create(key, "before", "summary", "context only", [{ id: "mixed", role: "assistant", text }]);
    await archives.link(key, archive.id, "next");
    const file = path.join(dir, archive.id + ".json"), before = await readFile(file);
    const reopened = new SessionArchives(home), evidence = await reopened.completionEvidence(key, "next");
    assert.equal(evidence.status, "available");
    const resolved = resolveCompletionContext(undefined, [], evidence.entries, []);
    const observation = resolved.observations.find(entry => entry.id.endsWith(":mixed"))!;
    assert.equal(observation.source, "archive"); assert.equal(observation.truncated, true);
    const projected = JSON.parse(observation.text);
    assert.equal(projected.blocks[1].id, "exact-call");
    assert.equal(projected.blocks[1].name, "write");
    assert.equal(typeof projected.blocks[1].argumentsExcerpt, "string");
    assert.equal(projected.blocks[1].arguments, undefined);
    assert.deepEqual(await readFile(file), before);
    assert.equal((await reopened.load(key, archive.id)).entries[0].text, text);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("projection bounds complete envelopes, escapes and huge tool metadata without inventing identity", () => {
  for (const limit of [512, 2000, 8000]) {
    for (const type of ["toolCall", "toolResult"]) {
      const result = projectObservation(JSON.stringify({ type, id: "c", name: "read", toolCallId: "c", toolName: "read", isError: true,
        arguments: { content: "\u0000\\\"界😀".repeat(50000) }, text: "\u0000\\\"界😀".repeat(50000), extra: "x".repeat(200000) }), type, limit);
      assert.ok(result.text.length <= limit);
      const data = JSON.parse(result.text);
      assert.equal(data.truncated, true);
      assert.equal(type === "toolCall" ? data.id : data.toolCallId, "c");
    }
  }
  const omitted = projectObservation(JSON.stringify({ type: "toolCall", id: "x".repeat(10000), name: "read", arguments: {} }), "assistant", 512);
  assert.equal(JSON.parse(omitted.text).omitted, true);
});
