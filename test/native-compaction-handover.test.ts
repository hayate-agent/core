import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { PiRuntime } from "../src/runtime/pi.js";
import { ContextMaintenance, contextPolicy } from "../src/context-maintenance.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";
import type { RuntimeSession } from "../src/types.js";

for (const aborted of [false, true]) test(`SDK compaction receipt distinguishes failure from intentional cancel: aborted=${aborted}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-receipt-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const models = await ModelRuntime.create({ refreshOnCreate: false });
  models.registerProvider("receipt-fixture", { api: "openai-completions", baseUrl: "https://offline.invalid", apiKey: "offline", models: [{
    id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 131072, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }] });
  const runtime = new PiRuntime({ cwd: home, sessionsDir: path.join(home, "sessions"), model: "receipt-fixture/model", skillPaths: [], tools: [], personaSections: async () => [], approvals: { mode: "off", tools: [] } });
  (runtime as any).modelRuntime = async () => models;
  const wrapped: any = await runtime.open("chat");
  const sdk = wrapped.session;
  // Exercise PiSession's real event subscription without any provider network.
  sdk.prompt = async () => {
    sdk.sessionManager.appendMessage({ role: "user", content: "preserve the genuine operator task", timestamp: 1 });
    sdk._emit({ type: "compaction_end", reason: "threshold", result: undefined, aborted, willRetry: false });
  };
  sdk.waitForIdle = async () => {};
  await wrapped.prompt("fixture");
  assert.equal(!!wrapped.status().nativeCompactionFailure, !aborted);
  if (!aborted) {
    const receipt = wrapped.status().nativeCompactionFailure;
    assert.equal(receipt.reason, "threshold"); await wrapped.dispose();
    const restored: any = await runtime.open("chat");
    assert.deepEqual(restored.status().nativeCompactionFailure, receipt, "receipt survives native session restart");
    restored.session.sessionManager.appendCustomEntry("harness-native-compaction-v1", { state: "applied", reason: "threshold" });
    assert.equal(restored.status().nativeCompactionFailure, undefined); await restored.dispose();
  } else await wrapped.dispose();
});

test("settled SDK failure rotates to a linked archive with no summary-model retry or working-effect replay", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-handover-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let work = 0, summaries = 0, rotations = 0;
  const key = "main";
  const entries = [{ id: "operator", role: "user", text: "Inspect once; do not deploy" },
    { id: "call", role: "assistant", text: '{"type":"toolCall","id":"effect-once","name":"probe","arguments":{}}' },
    { id: "receipt", role: "toolResult", text: '{"toolCallId":"effect-once","text":"inspection done; receipt 123; remote effect unknown"}' }];
  const maintenance = new ContextMaintenance(home, () => contextPolicy(), undefined, Date.now, async () => { summaries++; throw Error("must not retry failed summary"); });
  const runtime = new FakeRuntime(() => { work++; return "verified remaining check"; });
  const open = runtime.open.bind(runtime);
  runtime.open = async (sessionKey, options) => {
    const session = await open(sessionKey, options); const fresh = !!options?.fresh;
    if (fresh) rotations++;
    session.status = () => ({ sessionId: fresh ? "fresh" : "old", contextPercent: 1,
      ...(!fresh && work ? { nativeCompactionFailure: { reason: "threshold" as const, receiptId: "native-failed" } } : {}) });
    session.archiveEntries = () => entries;
    session.seedHandover = async text => { assert.match(text, /Archive ID:/); assert.match(text, /Read the archived conversation/); assert.match(text, /not be replayed blindly/); };
    return session;
  };
  const harness = new Harness({ runtime, contextMaintenance: maintenance, tickMs: 60000 });
  harness.onStateChange = async () => {}; harness.addChannel(new MemoryChannel()); t.after(() => harness.stop(0));
  await harness.accept({ sessionKey: key, source: "api", id: "first", text: "Inspect once; do not deploy", replyTo: { channel: "mem", target: "operator" } });
  await harness.waitForSessionIdle(key);
  assert.equal(work, 1); assert.equal(rotations, 1); assert.equal(summaries, 0);
  const state = await maintenance.status(key);
  assert.equal(state.sessionId, "fresh"); assert.equal(state.pending, undefined);
  assert.equal(state.recovery?.state, "applied");
  const archive = await maintenance.archives.load(key, state.handover!.archiveId!);
  assert.deepEqual(archive.entries, entries); assert.equal(archive.targetSessionId, "fresh");
  await harness.accept({ sessionKey: key, source: "api", id: "next", text: "Perform the separate remaining read-only check", replyTo: { channel: "mem", target: "operator" } });
  await harness.waitForSessionIdle(key);
  assert.equal(work, 2); assert.equal(rotations, 1); assert.equal(summaries, 0);
});

for (const policy of [{ enabled: false }, { autoHandover: false }]) test(`SDK failure does not override configured maintenance policy: ${JSON.stringify(policy)}`, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-policy-")); t.after(() => rm(home, { recursive: true, force: true }));
  const maintenance = new ContextMaintenance(home, () => contextPolicy(policy));
  const session = { status: () => ({ sessionId: "old", nativeCompactionFailure: { reason: "threshold", receiptId: "failed" } }) } as RuntimeSession;
  await maintenance.boundary("chat", session, async () => { throw Error("policy forbids rotation"); });
  assert.equal((await maintenance.status("chat")).pending, undefined);
});
