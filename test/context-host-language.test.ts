import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { Harness, NO_REPLY } from "../src/harness.js";
import type { RuntimeSession } from "../src/types.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

for (const [locale, expected] of [["en", /history archived/], ["de", /Verlauf archiviert/], ["es", /historial archivado/], ["ru", /история сохранена/]] as const) {
  test(`handover notification uses ${locale}`, async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), "handover-lang-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const m = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, undefined, () => locale);
    const old = { status: () => ({ sessionId: "old" }), archiveEntries: () => [], summarize: async () => "state" } as unknown as RuntimeSession;
    await m.request("mem:room1", { action: "handover", preserve: "work", resume: "continue" });
    const result = await m.beforeTurn("mem:room1", old, async () => ({ status: () => ({ sessionId: "new" }) }) as RuntimeSession);
    assert.match(result!, expected);
  });
}

test("silent progress does not falsely claim the task was completed", async () => {
  const h = new Harness({ runtime: new FakeRuntime(() => NO_REPLY), language: () => ({ default: "en" }) });
  const channel = new MemoryChannel(); h.addChannel(channel); h.onStateChange = async () => {};
  try {
    await h.submit({ ...msg("Do the work"), progressId: "progress" }); await h.drained();
    assert.deepEqual(channel.sent, [], "NO_REPLY must not create or edit a message");
  } finally { await h.stop(0); }
});
