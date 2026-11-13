import test from "node:test";
import assert from "node:assert/strict";
import { assessCompletion } from "./completion-selected.js";
import { fitsCompletionPrompt, prefix, projectObservation, renderCompletionPrompt } from "../src/completion-budget.js";
import { completionPrompt } from "../src/builtin-plugins/completion-prompt.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { resolveCompletionContext } from "../src/completion-context.js";

const auth = { task: "Full exact scope. No deployments. " + "mandate ".repeat(1000), expiresAt: 20000 };
const signal = () => new AbortController().signal;

test("host final gate measures both complete UTF16 and UTF8 strings, including custom renderers", async () => {
  for (const text of ["x".repeat(56000), "x".repeat(56001), "界".repeat(20000), "😀".repeat(14000)]) {
    let calls = 0; const diagnostics: string[] = [];
    await assessCompletion({ review: async prompt => { calls++; assert.equal(prompt, text); return '{"state":"completed"}'; } },
      msg("task"), "reply", auth, signal(), undefined, () => 1000, () => text, value => diagnostics.push(value));
    assert.equal(calls, fitsCompletionPrompt(text) ? 1 : 0);
    if (!calls) assert.deepEqual(diagnostics, ["unavailable"]);
  }
});

test("195798 character evidence class: full mandate, final JSON, byte ceilings and newest evidence", async () => {
  const input = msg("request".repeat(10000));
  input.completionContext = { recent: [], tasks: [], resolved: resolveCompletionContext("task", [{ id: "task", text: auth.task, state: "active", provenance: "host-task-anchor" }],
    Array.from({ length: 48 }, (_, i) => ({ id: `old${i}`, role: "assistant", text: "old".repeat(8000) })),
    [{ id: "new", role: "toolResult", text: JSON.stringify({ type: "toolResult", toolCallId: "call", toolName: "read", isError: false, text: "最新" + "😀\\\"\u0000".repeat(195798) }) }]) };
  const before = JSON.stringify(input);
  let captured = "";
  await assessCompletion({ review: async prompt => { captured = prompt; return '{"state":"completed"}'; } }, input, "reply".repeat(40000), auth, signal(), undefined, () => 1000, completionPrompt);
  assert.ok(captured); assert.ok(fitsCompletionPrompt(captured));
  const data = JSON.parse(captured.split("DATA: ")[1]);
  assert.equal(data.task, auth.task); assert.equal(data.expiresAt, auth.expiresAt);
  const newest = data.context.resolved.observations.find((entry: { id: string }) => entry.id === "new");
  assert.ok(newest); const envelope = JSON.parse(newest.text);
  assert.equal(envelope.toolCallId, "call"); assert.equal(envelope.toolName, "read"); assert.equal(envelope.isError, false);
  assert.equal(JSON.stringify(input), before);
  assert.equal(renderCompletionPrompt(completionPrompt, input, "reply".repeat(40000), auth, () => 1000), captured);
});

test("unicode prefixes avoid introducing a split pair; tool JSON and legacy cut envelopes have visible markers", () => {
  assert.equal(prefix("a😀b", 2), "a");
  for (const text of ["äß".repeat(20000), "界".repeat(20000), "😀".repeat(20000), "\ud800".repeat(20000), "\\\"\u0000".repeat(20000)]) {
    const projected = projectObservation(JSON.stringify({ type: "toolResult", toolCallId: "c", toolName: "read", isError: true, text }), "toolResult", 2000);
    assert.equal(projected.truncated, true);
    assert.equal(JSON.parse(projected.text).toolCallId, "c");
  }
  const legacy = projectObservation('{"type":"toolResult","text":"' + "x".repeat(10000), "toolResult", 1000);
  assert.equal(JSON.parse(legacy.text).incomplete, true);
});

test("impossible exact mandate is unavailable without provider execution", async () => {
  let calls = 0; const diagnostics: string[] = [];
  await assessCompletion({ review: async () => { calls++; return "{}"; } }, msg("short"), "reply", { task: "界".repeat(56000) }, signal(), undefined, () => 1000, completionPrompt, value => diagnostics.push(value));
  assert.equal(calls, 0); assert.deepEqual(diagnostics, ["unavailable"]);
});

test("actual host collector + assessor + default renderer with fake backend and transcript failure recovery", async () => {
  for (const mode of ["available", "empty", "missing", "failed"] as const) {
    const runtime = new FakeRuntime(); let captured = "";
    const originalCreate = runtime.open.bind(runtime);
    runtime.open = async (...args) => {
      const session = await originalCreate(...args);
      if (mode !== "missing") session.archiveEntries = () => {
        if (mode === "failed") throw Error("private payload must not leak");
        return mode === "empty" ? [] : [{ id: "latest", role: "toolResult", text: JSON.stringify({ type: "toolResult", toolCallId: "c", toolName: "read", text: "newest " + "界".repeat(195798) }) }];
      };
      return session;
    };
    const h = new Harness({ runtime, tickMs: 60000, completionCheck: (input, reply, assessmentSignal) => assessCompletion({ review: async prompt => { captured = prompt; return '{"state":"completed"}'; } }, input, reply, input.completionAnchor ? { task: input.completionAnchor.task, expiresAt: input.continuationExpiresAt } : undefined, assessmentSignal, undefined, () => 1000, completionPrompt) });
    h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
    try {
      await h.submit(msg("Exact task. Do not activate.")); await h.drained();
      assert.ok(fitsCompletionPrompt(captured)); assert.ok(captured);
      const data = JSON.parse(captured.split("DATA: ")[1]);
      assert.equal(data.task, "Exact task. Do not activate.");
      assert.equal(data.context.resolved.transcript.current, mode);
      if (mode === "available") assert.ok(data.context.resolved.observations.some((entry: { id: string }) => entry.id === "latest"));
      assert.ok(!captured.includes("private payload"));
      const restored = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
      restored.restoreSessions(h.snapshotSessions());
      assert.ok(restored.snapshotSessions()[0].tasks?.some(task => task.original === "Exact task. Do not activate."));
      await restored.stop(0);
    } finally { await h.stop(0); }
  }
});
