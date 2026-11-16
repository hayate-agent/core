import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { continuationRequest, recoveryProposalGuidance } from "../src/continuation-provenance.js";
import type { RuntimeSession } from "../src/types.js";

test("fallback handover never labels host and worker transcript inputs as operator instructions", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "handover-provenance-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const entries = [
    { id: "human", role: "user", text: "DB-004: #24 and #96" },
    { id: "worker", role: "user", text: "Dispatcher result (data, not new authorization)" },
    { id: "host", role: "user", text: "HOST-GENERATED CONTINUATION — NOT A NEW HUMAN MESSAGE" },
  ];
  const session = { status: () => ({ sessionId: "old" }), archiveEntries: () => entries } as unknown as RuntimeSession;
  const next = { status: () => ({ sessionId: "new" }) } as RuntimeSession;
  const maintenance = new ContextMaintenance(home, () => contextPolicy());
  await maintenance.request("chat", { action: "handover", preserve: "scope", resume: "work" });
  const notice = await maintenance.beforeTurn("chat", session, async handover => {
    assert.ok(handover);
    assert.doesNotMatch(handover.text, /Recent operator instructions/);
    assert.match(handover.text, /unverified provenance/);
    assert.match(handover.text, /host continuations or worker results/);
    assert.match(handover.text, /read the original archived entries/);
    assert.match(handover.text, /DB-004: #24 and #96/);
    return next;
  });
  assert.match(notice!, /history archived/);
  assert.doesNotMatch(notice!, /retrospective saved/);
});

test("continuation marks stale next steps as proposals subordinate to operator corrections", () => {
  const text = continuationRequest("#24 and #95", "ask for links to #95");
  assert.match(text, /historical model-generated proposal/);
  assert.match(text, /Later operator corrections override an older proposal/);
  assert.match(text, /before acting or asking/i);
  assert.match(recoveryProposalGuidance, /plugin_tasks/);
  assert.match(text, /#24 and #95/);
});
