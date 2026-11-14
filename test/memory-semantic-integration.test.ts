import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginHost } from "../src/plugins.js";
import { MemoryService } from "../src/builtin-plugins/memory-service.js";
import { memoryPlugin } from "../src/builtin-plugins/memory-plugin.js";
import { memoryConsolidationHost } from "../src/memory-consolidation-host.js";
import { MemoryProviderLifecycle } from "../src/memory-provider-lifecycle.js";
import { FileMemoryStore } from "../src/memory-worker.js";
import { memoryConfig } from "../src/memory.js";
import type { AgentRuntime } from "../src/types.js";

test("materialized semantic plugin uses the real host bridge, reconnects and recalls the same durable summary", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "memory-semantic-integration-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const config = memoryConfig({ enabled: true, recallLimit: 1, consolidation: { tier: "local", model: "fixture/summary" } });
  let opens = 0, prompts = 0, disposals = 0, providers = 0;
  let unhealthy = false;
  const runtime = { async open(key: string, options: unknown) {
    opens++;
    assert.match(key, /^memory-consolidation:[0-9a-f-]{36}$/);
    assert.ok(!key.includes("private-one"));
    assert.deepEqual(options, { ephemeral: true, assessmentPurpose: "handover" });
    return {
      async prompt(text: string, options: unknown) {
        prompts++;
        assert.deepEqual(options, { model: "fixture/summary", thinking: "off" });
        assert.match(text, /Untrusted reported source data/);
        assert.match(text, /Keep the old service running/);
        return JSON.stringify({ decisions: ["Retain the existing service."], results: ["Only local checks were reported."], openPoints: ["Live delivery remains unverified."] });
      },
      async abort() { assert.fail("successful fixture must not abort"); },
      async dispose() { disposals++; },
    };
  } } as unknown as AgentRuntime;
  const lifecycle = new MemoryProviderLifecycle(async () => {
    providers++;
    const store = new FileMemoryStore(path.join(home, "memory"), config);
    await store.start();
    const status = store.status.bind(store);
    store.status = async () => {
      if (unhealthy) { unhealthy = false; throw Error("fixture health failure"); }
      return status();
    };
    return store;
  });
  t.after(() => lifecycle.close());
  await lifecycle.ensureConnected();
  const memory = new MemoryService(config, () => {}, home);
  memory.provider = lifecycle;
  const host = new PluginHost();
  t.after(() => host.stop());
  // Preserve the actual startup order: plugin activation precedes host registration.
  await host.load([], { agent: "fixture", home, cwd: home }, [], [], [
    memoryPlugin(memory), memoryConsolidationHost(config.consolidation!, runtime, memory, () => {}),
  ]);
  const turn = { sessionKey: "private-one", id: "turn-one", text: "Keep the old service running", reply: "Local checks passed, but no deployment was performed.", outcome: "completed" as const, recordedAt: 1800000000000 };
  await memory.capture(turn);
  await memory.flush();
  const recall = await memory.recall(turn.sessionKey, "unrelated next turn");
  assert.match(recall, /Turn summary v4/);
  assert.match(recall, /Retain the existing service/);
  assert.match(recall, /Live delivery remains unverified/);
  assert.match(recall, /reported/);
  assert.equal(await memory.recall("private-two", "service"), "");
  assert.equal((await lifecycle.status()).entries, 1);
  assert.equal((await readdir(path.join(home, "memory-pending"))).length, 0);
  await memory.capture(turn); await memory.flush();
  assert.equal(prompts, 1, "same turn receipt prevents another inference");
  unhealthy = true;
  await lifecycle.ensureConnected();
  assert.equal(providers, 2, "exclusive reconnect reopens the same real store");
  assert.equal(await memory.recall(turn.sessionKey, "unrelated next turn"), recall);
  await host.stop();
  await lifecycle.close();
  const reopened = new FileMemoryStore(path.join(home, "memory"), config);
  await reopened.start();
  t.after(() => reopened.close());
  const restarted = new MemoryService(config, () => {}, home);
  restarted.provider = reopened;
  restarted.summaryBackend = { async summarize() { assert.fail("durable receipt must survive restart"); } };
  assert.equal(await restarted.recall(turn.sessionKey, "unrelated next turn"), recall);
  await restarted.capture(turn); await restarted.flush();
  assert.equal((await reopened.status()).entries, 1);
  assert.deepEqual({ opens, prompts, disposals, providers }, { opens: 1, prompts: 1, disposals: 1, providers: 2 });
});
