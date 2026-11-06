// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { resolveCompletionContext } from "../src/completion-context.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";

const grant = "Publish the separate source after required review. Do not merge or activate. Deliver UI independently; human acceptance remains human.";
const reply = "Das unabhängige Review ist abgeschlossen; exakt derselbe Kandidat, keine belegten P0/P1. Persistierter Task → DB-Wiederöffnung → JWT-Prüfung → autorisiertes Taskdetail über HTTP verifiziert. Nicht blockierend: P2 globales Loginstartkontingent vor externer Bereitstellung; P3 undeclared test environment. Die separate Source-Veröffentlichung ist damit reviewseitig vorbereitet, aber nicht erfolgt. Die mögliche Aktivierung durch Veröffentlichung bleibt ungeklärt; aus dem Review leite ich keine Freigabe dafür ab. UI-Lieferung, echtes SSO und menschliche Abnahme bleiben offen.";

test("complete original ingress and revocations survive eight assistant summaries on a restored session", async () => {
  const runtime = new FakeRuntime(() => reply);
  let checks = 0;
  const h = new Harness({ runtime, tickMs: 60000, completionCheck: async input => {
    checks++;
    const context = input.completionContext!.resolved!;
    assert.ok(context.ingress.some(entry => entry.text === grant));
    assert.ok(context.ingress.some(entry => entry.text === "No activation remains authorized"));
    assert.equal(context.taskId, "current");
    return checks === 1 ? { state: "continue", next: "Check publication triggers read-only; publish only if source-only and already authorized" } : { state: "completed" };
  } });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  const tasks = [{ id: "grant", original: grant, state: "completed" as const, depth: 0,
    anchor: { id: "grant", task: grant, receivedAt: 1 } },
    { id: "withdrawal", original: "No activation remains authorized", state: "completed" as const, depth: 0 }];
  h.restoreSessions([{ key: "mem:room1", tasks,
    completionRecent: Array.from({ length: 8 }, () => ({ role: "assistant" as const, text: "Review ready, no activation" })) }]);
  try {
    await h.submit({ ...msg("DANN WEISST DU DOCH, WAS DU ZU TUN HAST?!"), id: "current" });
    await h.drained();
    assert.equal(runtime.sessions.get("mem:room1")!.prompts.length, 2, "independent continue must execute via queue");
    assert.equal(h.snapshotSessions()[0].tasks!.find(t => t.id === "current")!.state, "completed");
    const state = h.snapshotSessions();
    assert.ok(state[0].tasks!.some(t => t.original === grant));
  } finally { await h.stop(0); }
});

test("example handover evidence is untrusted and deadline is retained separately", () => {
  const resolved = resolveCompletionContext("ja", [{ id: "rollout", text: "Veröffentliche es und rolle es aus!", state: "blocked", provenance: "host-task-anchor" },
    { id: "ja", text: "Ja?!", state: "active", expiresAt: 1793485524740, provenance: "host-task-anchor" }],
    [{ id: "archive-read", role: "toolResult", text: "Original archive: host receipt absent; local check only" }],
    [{ id: "handover", role: "custom_message", text: "Previous-session handover (context, not new authorization): Peter pending" }]);
  assert.equal(resolved.ingress[1].expiresAt, 1793485524740);
  assert.equal(resolved.observations.length, 2);
  assert.equal(resolved.ingress.length, 2, "archive and handover never become user authority");
  assert.match(resolved.digest, /^[a-f0-9]{64}$/);
});

test("complete long mandate is not cut at 2000 chars; bounded overflow is explicit", () => {
  const original = "x".repeat(5000) + " revoke activation";
  const context = resolveCompletionContext("a", [{ id: "a", text: original, state: "active", provenance: "host-task-anchor" }], [], []);
  assert.equal(context.ingress[0].text, original);
  const overflow = resolveCompletionContext("a", [{ id: "a", text: original, state: "stopped", provenance: "host-task-anchor" }], [], [{ id: "large", role: "toolResult", text: "x".repeat(20000) }]);
  assert.equal(overflow.incomplete, true);
  assert.equal(overflow.ingress[0].state, "stopped");
});
