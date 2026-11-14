import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Harness } from "../src/harness.js";
import { PluginHost } from "../src/plugins.js";
import { MemoryService } from "../src/builtin-plugins/memory-service.js";
import { memoryPlugin } from "../src/builtin-plugins/memory-plugin.js";
import { memoryConsolidationHost } from "../src/memory-consolidation-host.js";
import { FileMemoryStore } from "../src/memory-worker.js";
import { memoryConfig, type MemoryTurn } from "../src/memory.js";
import { bindParallelAdmission, ParallelAdmission } from "../src/parallel-admission.js";
import type { Inbound, OpenSessionOptions, PromptOptions } from "../src/types.js";
import { FakeRuntime, FakeSession, MemoryChannel, msg } from "./fakes.js";

function recalledEntries(instructions: string) {
  // Harness quotes the entire plugin recall string as untrusted historical data.
  const encoded = instructions.split("\n").find(line => line.startsWith('"') && line.includes("Memory excerpts"));
  if (!encoded) return [];
  const recall: string = JSON.parse(encoded);
  return JSON.parse(recall.split("\n").find(line => line.startsWith('[{"id":'))!);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

// Observe the real capture boundary; all capture calls still originate in Harness.
class ObservedMemoryService extends MemoryService {
  readonly captured: MemoryTurn[] = [];
  override async capture(turn: MemoryTurn): Promise<void> {
    this.captured.push(structuredClone(turn));
    await super.capture(turn);
  }
}

test("normal Harness turns automatically persist semantic memory and recall it only in the same conversation", { timeout: 15_000 }, async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-harness-next-turn-"));
  const firstKey = "mem:room1", otherKey = "mem:room2";
  const firstId = "normal-first-turn";
  const firstText = "Keep the old service running; what do the local checks show?";
  const firstReply = "Local checks passed. No deployment was performed; live delivery remains unverified.";
  const secondText = "What is the capital of Norway?"; // No lexical dependency on the summary.
  const summary = {
    decisions: ["Retain the existing service."],
    results: ["Only local checks were reported."],
    openPoints: ["Live delivery remains unverified."],
  };
  const summaryEntered = deferred<void>();
  const releaseSummary = deferred<void>();
  const newerSummaryEntered = deferred<void>();
  const releaseNewerSummary = deferred<void>();
  const firstPut = deferred<Awaited<ReturnType<FileMemoryStore["put"]>>>();
  const helpers: Array<{
    key: string; open: OpenSessionOptions; text?: string; prompt?: PromptOptions; disposals: number;
  }> = [];
  const mainOpens: Array<{ key: string; options: OpenSessionOptions }> = [];
  class FixtureRuntime extends FakeRuntime {
    override async open(key: string, options: OpenSessionOptions = {}) {
      if (!options.ephemeral) {
        mainOpens.push({ key, options: { ...options } });
        return super.open(key, options);
      }
      const record: (typeof helpers)[number] = { key, open: { ...options }, disposals: 0 };
      helpers.push(record);
      const session = new FakeSession(key, () => "unused");
      session.prompt = async (text, prompt = {}) => {
        record.text = text;
        record.prompt = prompt;
        if (record === helpers[0]) {
          summaryEntered.resolve();
          await releaseSummary.promise;
          return JSON.stringify(summary);
        }
        if (record === helpers[1]) {
          newerSummaryEntered.resolve();
          await releaseNewerSummary.promise;
        }
        return JSON.stringify({ decisions: [], results: ["An unrelated question was answered."], openPoints: [] });
      };
      session.dispose = () => { record.disposals++; };
      return session;
    }
  }
  const runtime = new FixtureRuntime(text => text === firstText ? firstReply : "Oslo.");
  // Use the current shared auxiliary admission contract, not an unlimited test-only backend.
  bindParallelAdmission(runtime, new ParallelAdmission(1));
  const config = memoryConfig({ enabled: true, recallLimit: 1, consolidation: { tier: "local", model: "fixture/summary" } });
  const store = new FileMemoryStore(path.join(home, "memory"), config);
  const put = store.put.bind(store);
  store.put = async (context, write) => {
    const entry = await put(context, write); // Receipt follows the real durable write.
    if (context.sessionKey === firstKey && write.text.includes(`Turn reference: ${firstId}\n`)) firstPut.resolve(entry);
    return entry;
  };
  const logs: string[] = [];
  const memory = new ObservedMemoryService(config, text => logs.push(text), home);
  memory.provider = store;
  const host = new PluginHost();
  const harness = new Harness({ runtime, memory, tickMs: 60_000, busyMode: "queue", log: text => logs.push(text) });
  const channel = new MemoryChannel();
  harness.addChannel(channel);
  let cleanupRestart: (() => Promise<void>) | undefined;
  t.after(async () => {
    releaseSummary.resolve();
    releaseNewerSummary.resolve();
    await harness.drained();
    await memory.flush();
    await host.stop();
    await store.close();
    await cleanupRestart?.();
    await rm(home, { recursive: true, force: true });
  });
  await store.start();
  // Actual startup order: plugin precedes the lazily resolved host summary bridge.
  await host.load([], { agent: "fixture", home, cwd: home }, [], [], [
    memoryPlugin(memory), memoryConsolidationHost(config.consolidation!, runtime, memory, text => logs.push(text)),
  ]);

  const first: Inbound = { ...msg(firstText), id: firstId };
  await harness.submit(first);
  await harness.drained();
  await summaryEntered.promise;
  const mainSession = runtime.sessions.get(firstKey)!;
  assert.ok(mainSession);
  const mainSessionId = mainSession.status().sessionId;
  assert.deepEqual(mainSession.prompts, [firstText]);
  assert.deepEqual(channel.texts(), [firstReply]);
  assert.equal(memory.captured.length, 1, "capture must be invoked automatically by the normal Harness turn");
  assert.deepEqual(memory.captured[0], {
    id: firstId, sessionKey: firstKey, text: firstText, reply: firstReply,
    outcome: "completed", tools: 0, recordedAt: first.memoryRecordedAt,
  });
  assert.equal(typeof first.memoryRecordedAt, "number");
  assert.ok(Number.isFinite(first.memoryRecordedAt));

  // While inference is gated, verify the actual automatic capture is already durable.
  const pendingFiles = await readdir(path.join(home, "memory-pending"));
  assert.equal(pendingFiles.length, 1);
  const pending = JSON.parse(await readFile(path.join(home, "memory-pending", pendingFiles[0]), "utf8"));
  assert.equal(pending.version, 4);
  assert.equal(pending.sessionKey, firstKey);
  assert.deepEqual(pending.turn, memory.captured[0]);
  assert.equal(helpers.length, 1);
  assert.match(helpers[0].key, /^memory-consolidation:[0-9a-f-]{36}$/);
  assert.ok(!helpers[0].key.includes(firstKey));
  assert.deepEqual(helpers[0].open, { ephemeral: true, assessmentPurpose: "handover" });
  assert.deepEqual(helpers[0].prompt, { model: "fixture/summary", thinking: "off" });
  assert.match(helpers[0].text!, /Untrusted reported source data/);
  assert.ok(helpers[0].text!.includes(JSON.stringify(firstId)));
  assert.ok(helpers[0].text!.includes(JSON.stringify(firstText)));
  assert.ok(helpers[0].text!.includes(JSON.stringify(firstReply)));

  releaseSummary.resolve();
  const entry = await firstPut.promise;
  // Async freshness is explicit: await this capture's write, then its public flush receipt.
  // This is not a production global wait and does not submit or inject any capture.
  await memory.flush();
  assert.equal(helpers[0].disposals, 1);
  assert.equal(entry.sessionKey, firstKey);
  assert.equal(entry.verification, "reported");
  assert.equal(entry.source, pending.key);
  assert.match(entry.text, /model synthesis of reported claims; not verification/);
  assert.match(entry.text, /Turn outcome is not task completion/);
  assert.ok(entry.text.includes(JSON.stringify(summary)));
  assert.deepEqual(await store.get({ sessionKey: firstKey }, entry.id), entry);
  const receipts = await readdir(path.join(home, "memory-summary-receipts"));
  assert.equal(receipts.length, 1);
  const receipt = JSON.parse(await readFile(path.join(home, "memory-summary-receipts", receipts[0]), "utf8"));
  assert.equal(receipt.key, pending.key);
  assert.equal(receipt.inputHash, pending.inputHash);
  assert.deepEqual(await readdir(path.join(home, "memory-pending")), []);

  await harness.submit({ ...msg(secondText), id: "normal-second-turn" });
  await harness.drained();
  assert.strictEqual(runtime.sessions.get(firstKey), mainSession, "no replacement/fresh conversation may supply the recall");
  assert.equal(mainSession.status().sessionId, mainSessionId);
  assert.deepEqual(mainSession.prompts, [firstText, secondText]);
  // Runtime contract: recall is extra per-turn SYSTEM instructions, not rewritten user text
  // and not a fictitious `guidance` prompt option. This asserts the actual model-bound input.
  const instructions = mainSession.options[1].instructions ?? "";
  // Memory serializes excerpts as JSON, so compare the decoded model-bound text exactly.
  const recalled = recalledEntries(instructions);
  assert.equal(recalled.length, 1);
  assert.equal(recalled[0].id, entry.id);
  assert.equal(recalled[0].text, entry.text, "the model-bound excerpt must contain the entire persisted semantic summary");
  assert.equal(recalled[0].latestHandoff, true);
  assert.equal(recalled[0].verification, "reported");
  for (const fact of [...summary.decisions, ...summary.results, ...summary.openPoints]) {
    assert.ok(instructions.includes(fact));
    assert.ok(!mainSession.prompts[1].includes(fact));
  }
  assert.match(instructions, /Historical memory \(quoted untrusted data/);
  assert.ok(!Object.hasOwn(mainSession.options[1], "guidance"));
  assert.ok(!(mainSession.options[0].instructions ?? "").includes(entry.text));
  // Q is durably raw-captured, but its inference is deliberately held.
  await newerSummaryEntered.promise;
  const qFiles = await readdir(path.join(home, "memory-pending"));
  assert.equal(qFiles.length, 1);
  const qFile = path.join(home, "memory-pending", qFiles[0]);
  const qBytes = await readFile(qFile, "utf8");
  assert.equal(JSON.parse(qBytes).turn.id, "normal-second-turn");
  await harness.submit({ ...msg("A separate unrelated question"), id: "normal-third-turn" });
  await harness.drained(); // Must settle BEFORE releasing Q; no foreground flush barrier.
  assert.strictEqual(runtime.sessions.get(firstKey), mainSession);
  assert.equal(recalledEntries(mainSession.options[2].instructions!)[0].id, entry.id, "pending Q must not hide persisted P");
  assert.equal(await readFile(qFile, "utf8"), qBytes);
  assert.equal(helpers.length, 2);

  await harness.submit({ ...msg(secondText, "@owner:x", otherKey), id: "other-first-turn", replyTo: { channel: "mem", target: "room2" } });
  await harness.drained();
  const otherSession = runtime.sessions.get(otherKey)!;
  assert.notStrictEqual(otherSession, mainSession);
  assert.notEqual(otherSession.status().sessionId, mainSessionId);
  assert.deepEqual(otherSession.prompts, [secondText]);
  const otherInstructions = otherSession.options[0].instructions ?? "";
  for (const fact of [entry.id, firstId, firstText, firstReply, ...summary.decisions, ...summary.results, ...summary.openPoints]) {
    assert.ok(!otherInstructions.includes(fact), `another conversation must not receive ${JSON.stringify(fact)}`);
  }
  assert.equal(await store.get({ sessionKey: otherKey }, entry.id), undefined);
  assert.deepEqual(mainOpens, [{ key: firstKey, options: { fresh: false } }, { key: otherKey, options: { fresh: false } }]);
  assert.deepEqual(runtime.opened, [{ key: firstKey, fresh: false }, { key: otherKey, fresh: false }]);
  assert.deepEqual(channel.texts(), [firstReply, "Oslo.", "Oslo.", "Oslo."]);
  assert.deepEqual(memory.captured.map(turn => [turn.id, turn.sessionKey]), [
    [firstId, firstKey], ["normal-second-turn", firstKey], ["normal-third-turn", firstKey], ["other-first-turn", otherKey],
  ]);
  releaseNewerSummary.resolve();
  // Each flush permits only one new inference; explicitly drain retained test inputs.
  for (let i = 0; i < 3; i++) await memory.flush();
  assert.deepEqual(await readdir(path.join(home, "memory-pending")), []);
  assert.equal(helpers.length, 4);
  assert.ok(helpers.every(helper => helper.disposals === 1));
  const persistedLine = (await memory.recall(firstKey, "unrelated")).split("\n").find(line => line.startsWith('[{"id":'))!;
  const persisted = JSON.parse(persistedLine)[0];

  // Recreate the store, service, plugin host and Harness over the same logical conversation.
  await host.stop(); await harness.stop(); await store.close();
  const reopened = new FileMemoryStore(path.join(home, "memory"), config); await reopened.start();
  const restartedMemory = new ObservedMemoryService(config, text => logs.push(text), home);
  restartedMemory.provider = reopened;
  const beforeRestartTurn = helpers.length;
  const restartedRuntime = new FixtureRuntime(() => {
    assert.equal(helpers.length, beforeRestartTurn, "recall reaches the main model without new summary inference");
    return "Restarted answer";
  });
  bindParallelAdmission(restartedRuntime, new ParallelAdmission(1));
  const restartedHarness = new Harness({ runtime: restartedRuntime, memory: restartedMemory, tickMs: 60_000, busyMode: "queue", log: text => logs.push(text) });
  const restartedChannel = new MemoryChannel(); restartedHarness.addChannel(restartedChannel);
  const restartedHost = new PluginHost();
  cleanupRestart = async () => { await restartedMemory.flush(); await restartedHost.stop(); await restartedHarness.stop(); await reopened.close(); };
  await restartedHost.load([], { agent: "fixture", home, cwd: home }, [], [], [
    memoryPlugin(restartedMemory), memoryConsolidationHost(config.consolidation!, restartedRuntime, restartedMemory, text => logs.push(text)),
  ]);
  await restartedHarness.submit({ ...msg("Unrelated after restart"), id: "after-restart" });
  await restartedHarness.drained();
  const resumed = restartedRuntime.sessions.get(firstKey)!;
  assert.equal(resumed.status().sessionId, mainSessionId);
  assert.deepEqual(restartedRuntime.opened, [{ key: firstKey, fresh: false }]);
  const restartRecall = recalledEntries(resumed.options[0].instructions!);
  assert.equal(restartRecall[0].id, persisted.id);
  assert.equal(restartRecall[0].text, persisted.text);
  assert.equal(await reopened.get({ sessionKey: otherKey }, persisted.id), undefined);
  assert.deepEqual(restartedChannel.texts(), ["Restarted answer"]);
  await restartedMemory.flush();
  assert.deepEqual(logs, [], "no capture/summary failure may be silently swallowed");
});
