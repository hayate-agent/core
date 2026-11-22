import assert from "node:assert/strict";
import test from "node:test";
import { currentRunContext, retireRunContexts, runContextPressure } from "../src/run-context.js";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// Installed SDK estimator: prove the invalidation itself, not a mocked usage API.
const { estimateProjectedContextTokens, prepareCompaction } = await import(new URL(
  "core/compaction/compaction.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const assistant = (tokens: number, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", api: "openai-completions", provider: "fixture", model: "fixture", content: [{ type: "text", text: "Retained uncertain effect" }],
  timestamp: Date.now(), stopReason, usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: tokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("only obsolete agent-owned run snapshots are excluded, never operator evidence or other custom messages", () => {
  const messages = [
    { role: "custom", customType: "harness-run-context", content: "old snapshot" },
    { role: "user", content: "harness-run-context: operator correction must remain exact" },
    { role: "assistant", content: "uncertain effect: reconcile before retry" },
    { role: "toolResult", content: "exact effect receipt" },
    { role: "custom", customType: "harness-handover", content: "unfinished work" },
    { role: "custom", customType: "harness-skill-reference", content: "untrusted skill" },
    { role: "custom", customType: "harness-run-context", content: "current snapshot" },
  ];
  const original = structuredClone(messages);
  assert.deepEqual(currentRunContext(messages), messages.slice(1));
  assert.deepEqual(messages, original, "native archive is never mutated");
  assert.equal(currentRunContext(messages.slice(1)).length, 6);
  const noSnapshot = messages.slice(1, 6);
  assert.equal(currentRunContext(noSnapshot), noSnapshot);
});

test("repeated full snapshots do not grow active run instructions", () => {
  const messages = Array.from({ length: 200 }, (_, i) => [
    { role: "custom", customType: "harness-run-context", content: `snapshot-${i}:` + "x".repeat(19000) },
    { role: "user", content: `request-${i}` },
    { role: "toolResult", content: `receipt-${i}` },
  ]).flat();
  const projected = currentRunContext(messages);
  assert.equal(projected.filter(m => m.customType === "harness-run-context").length, 1);
  assert.equal(projected.filter(m => m.role === "user").length, 200);
  assert.equal(projected.filter(m => m.role === "toolResult").length, 200);
  assert.equal(messages.length, 600);
});

test("snapshot-only retirement keeps a conservative measured floor before another response, including reload", () => {
  let manager = SessionManager.inMemory();
  const session = { get sessionManager() { return manager; }, refreshContext() {}, getContextUsage() {
    return { tokens: estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens, contextWindow: 131072, percent: 0 };
  } } as unknown as AgentSession;
  for (let i = 0; i < 3; i++) {
    manager.appendCustomMessageEntry("harness-run-context", `OLD-${i}`, false);
    manager.appendMessage({ role: "user", content: `exact request ${i} ` + "evidence ".repeat(1000), timestamp: Date.now() });
    manager.appendMessage(assistant(50020));
    assert.equal(runContextPressure(session), undefined, "genuine usage needs no adjustment");
    assert(retireRunContexts(session, false));
    assert(session.getContextUsage()!.tokens! < 10000, "SDK really invalidated usage");
    assert.equal(runContextPressure(session)!.tokens, 50020);
    assert.equal(retireRunContexts(session, false), false);
    const saved = [manager.getHeader(), ...manager.getEntries()];
    manager = SessionManager.inMemory(undefined, undefined, structuredClone(saved).filter(e => e !== null));
    assert.equal(runContextPressure(session)!.tokens, 50020, "debt is branch-derived, not process-local");
  }
  assert.equal(manager.getEntries().filter(e => e.type === "custom_message").length, 3);
  assert.doesNotMatch(JSON.stringify(manager.buildSessionProjection().messages), /OLD-/);
  const preparation = prepareCompaction(manager.getBranch(), { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 });
  assert(preparation);
  assert.doesNotMatch(JSON.stringify(preparation), /OLD-/);
  manager.appendCompaction("Only original requests and effect evidence", preparation.firstKeptEntryId, 50020);
  assert.equal(runContextPressure(session), undefined, "compaction releases stale pre-compaction pressure");
});

test("zero/error/aborted usage cannot erase debt; fresh usage and unrelated edits invalidate it", () => {
  const manager = SessionManager.inMemory();
  const session = { sessionManager: manager, refreshContext() {}, getContextUsage() {
    return { tokens: estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens };
  } } as unknown as AgentSession;
  manager.appendCustomMessageEntry("harness-run-context", "retire me", false);
  const user = manager.appendMessage({ role: "user", content: "Exact operator request", timestamp: Date.now() });
  manager.appendMessage(assistant(50020)); retireRunContexts(session, false);
  for (const response of [assistant(0), assistant(80000, "error"), assistant(80000, "aborted")]) {
    manager.appendMessage(response);
    assert(runContextPressure(session)!.tokens >= 50020);
  }
  manager.appendMessage(assistant(12000));
  assert.equal(runContextPressure(session), undefined);
  manager.appendCustomMessageEntry("harness-run-context", "another", false); retireRunContexts(session, false);
  assert(runContextPressure(session));
  manager.appendContextEdit(user, { content: "Changed context, not snapshot retirement" });
  assert.equal(runContextPressure(session), undefined, "never trust old usage across arbitrary replacement");
});

test("obsolete per-run skill references are retired like run snapshots, never operator evidence or handover", () => {
  const manager = SessionManager.inMemory();
  const session = { sessionManager: manager, refreshContext() {}, getContextUsage: () => undefined } as unknown as AgentSession;
  for (let i = 0; i < 4; i++) {
    manager.appendCustomMessageEntry("harness-run-context", `RUN-${i}`, false);
    manager.appendCustomMessageEntry("harness-skill-reference", `SKILL-${i}:` + "x".repeat(28000), false);
    manager.appendMessage({ role: "user", content: `exact operator request ${i}`, timestamp: Date.now() });
  }
  manager.appendCustomMessageEntry("harness-handover", "unfinished work", false);
  const active = () => manager.buildSessionProjection().messages.filter((m: any) => m.role === "custom").map((m: any) => m.customType);
  assert.equal(active().filter(t => t === "harness-skill-reference").length, 4);
  // Reopen keeps only the latest of each agent-owned kind.
  assert(retireRunContexts(session, true));
  assert.equal(active().filter(t => t === "harness-skill-reference").length, 1);
  assert.equal(active().filter(t => t === "harness-run-context").length, 1);
  assert.equal(active().filter(t => t === "harness-handover").length, 1, "handover is never retired");
  // A new run retires every obsolete reference before its own is appended.
  assert(retireRunContexts(session, false));
  assert.equal(active().filter(t => t === "harness-skill-reference").length, 0);
  assert.equal(manager.buildSessionProjection().messages.filter((m: any) => m.role === "user").length, 4, "operator requests stay exact");
  // Originals remain in the archive.
  assert.equal(manager.getEntries().filter((e: any) => e.type === "custom_message" && e.customType === "harness-skill-reference").length, 4);
  // Request-time projection also keeps only the latest reference.
  const wire = [
    { role: "custom", customType: "harness-skill-reference", content: "old skill" },
    { role: "user", content: "operator" },
    { role: "custom", customType: "harness-skill-reference", content: "current skill" },
  ];
  assert.deepEqual(currentRunContext(wire).map(m => m.content), ["operator", "current skill"]);
});

test("retiring skill references keeps the conservative measured floor", () => {
  const manager = SessionManager.inMemory();
  const session = { sessionManager: manager, refreshContext() {}, getContextUsage() {
    return { tokens: estimateProjectedContextTokens(manager.buildSessionProjection(), manager.getBranch()).tokens };
  } } as unknown as AgentSession;
  manager.appendCustomMessageEntry("harness-skill-reference", "SKILL " + "x".repeat(28000), false);
  manager.appendMessage({ role: "user", content: "Exact operator request", timestamp: Date.now() });
  manager.appendMessage(assistant(50020));
  assert(retireRunContexts(session, false));
  assert.equal(runContextPressure(session)!.tokens, 50020, "skill-reference retirement is not an unrelated replacement");
});
