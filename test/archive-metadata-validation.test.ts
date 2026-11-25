import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { SessionArchives } from "../src/session-archive.js";

test("archive metadata is validated before summary reads and completion traversal", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "archive-metadata-"));
  try {
    const store = new SessionArchives(home);
    const archive = await store.create("room", "old", "summary", "forward", [{ id: "e", role: "user", text: "hello" }]);
    const file = path.join(home, "session-archives", createHash("sha256").update("room").digest("hex"), `${archive.id}.json`);
    for (const field of ["sourceSessionId", "createdAt", "retrospective", "forward", "targetSessionId"]) {
      for (const value of [null, 42, [], {}]) {
        await writeFile(file, JSON.stringify({ ...archive, [field]: value }));
        await assert.rejects(store.load("room", archive.id), /Invalid session archive/);
        await assert.rejects(store.read("room", archive.id, { section: "summary" }), /Invalid session archive/);
        const evidence = await store.completionEvidence("room", "next");
        assert.equal(evidence.status, "failed");
        assert.equal(evidence.incomplete, true);
      }
      if (field !== "targetSessionId") {
        const missing = { ...archive } as Record<string, unknown>;
        delete missing[field];
        await writeFile(file, JSON.stringify(missing));
        await assert.rejects(store.load("room", archive.id), /Invalid session archive/);
      }
    }
    // Optional legacy target and arbitrary string metadata remain compatible.
    await writeFile(file, JSON.stringify({ ...archive, createdAt: "legacy date" }));
    assert.equal((await store.load("room", archive.id)).targetSessionId, undefined);
    assert.equal(JSON.parse(await store.read("room", archive.id, { section: "summary" })).retrospective, "summary");
    await store.link("room", archive.id, "next");
    assert.equal((await store.completionEvidence("room", "next")).status, "available");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
