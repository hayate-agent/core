import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SessionArchives } from "../src/session-archive.js";

test("archive retains source, retrospective and bounded searchable original entries", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "session-archive-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const archives = new SessionArchives(home);
  const archive = await archives.create("chat-a", "old-session", "Decided X because Y", "Next: tests", [{ id: "entry-1", role: "user", text: "Preserve deployment status " + "x".repeat(2000) }]);
  await archives.link("chat-a", archive.id, "new-session");
  assert.equal((await archives.load("chat-a", archive.id)).targetSessionId, "new-session");
  assert.match(await archives.read("chat-a", archive.id, { section: "summary" }), /Decided X/);
  const read = JSON.parse(await archives.read("chat-a", archive.id, { query: "deployment", limit: 1 }));
  assert.equal(read.entries[0].id, "entry-1");
  assert.equal(read.entries[0].text.length, 1500);
  assert.equal(read.entries[0].truncated, true);
  const linked = await archives.completionEvidence("chat-a", "new-session");
  assert.ok(linked.entries.some(entry => entry.role === "archive-summary" && entry.text.includes("Decided X")));
  assert.ok(linked.entries.some(entry => entry.role === "archive-user"));
  assert.equal((await archives.completionEvidence("chat-b", "new-session")).entries.length, 0);
  assert.equal((await archives.completionEvidence("chat-a", "unrelated-session")).entries.length, 0);
  await assert.rejects(archives.load("chat-b", archive.id));
  await assert.rejects(archives.load("chat-a", "../../etc/passwd"));
  await assert.rejects(archives.read("chat-a", archive.id, { limit: 1000 }));
});
