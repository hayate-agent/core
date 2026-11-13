import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSession } from "../src/runtime/pi.js";
import { recoveryEvidence } from "../src/recovery-evidence.js";

for (const partial of [false, true]) test(`real SDK handover persistence (${partial ? "existing metadata-only partial" : "new"} file) is bounded and recoverable`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "handover-persistence-"));
  try {
    let manager = SessionManager.create(dir, dir);
    if (partial) {
      // Exactly the valid prefix left when first persistence failed after creating
      // the file but before JSON-stringifying a giant recursively quoted seed.
      await writeFile(manager.getSessionFile()!, JSON.stringify(manager.getHeader()) + "\n");
      manager = SessionManager.open(manager.getSessionFile()!, dir, dir);
    }
    let mutations = 0;
    const agent = { sessionManager: manager, sendCustomMessage: async (m: { customType: string; content: string; display: boolean }) => {
      mutations++; manager.appendCustomMessageEntry(m.customType, m.content, m.display);
    } };
    const session = new PiSession(agent as never, {} as never, {});
    await assert.rejects(session.seedHandover("x".repeat(65537)), /safe context budget/);
    assert.equal(mutations, 0, "oversized seed rejected before any in-memory/disk mutation");
    if (!partial) await assert.rejects(stat(manager.getSessionFile()!), { code: "ENOENT" });
    const seed = recoveryEvidence("retained-source", { sessionId: "old", sessionFile: "/retained/original.jsonl" },
      [{ id: "quoted", role: "toolResult", text: "\u0000\\\"😀".repeat(30000) }, { id: "receipt", role: "toolResult", text: "effect already performed" }]);
    await session.seedHandover(seed);
    await session.seedHandover(seed);
    manager.appendMessage({ role: "user", content: "Read-only verification; do not repeat effects", timestamp: 1000 });
    const persisted = await readFile(manager.getSessionFile()!, "utf8");
    assert.ok(Buffer.byteLength(persisted) < 512 * 1024);
    const restored = SessionManager.open(manager.getSessionFile()!, dir, dir);
    assert.equal(restored.getBranch().filter(e => e.type === "custom_message").length, 1, "idempotent seed, including persistence retry");
    assert.match(persisted, /effect already performed/);
    restored.appendMessage({ role: "user", content: "Still read-only", timestamp: 1001 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
