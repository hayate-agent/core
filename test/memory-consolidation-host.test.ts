import test from "node:test";
import assert from "node:assert/strict";
import { memoryConfig } from "../src/memory.js";
import { memoryConsolidationHost } from "../src/memory-consolidation-host.js";
import type { AgentRuntime } from "../src/types.js";
import type { PluginAPI } from "../src/plugins.js";

test("consolidation config requires explicit model and tier with bounded timeout", () => {
  for (const consolidation of [{}, { tier: "local", model: "guess" }, { tier: "frontier", model: "p/m", timeoutMs: 1 }]) {
    assert.throws(() => memoryConfig({ consolidation } as any), /consolidation/);
  }
  assert.equal(memoryConfig({ consolidation: { tier: "local", model: "p/m" } }).consolidation?.tier, "local");
});

test("host uses ephemeral isolated session, explicit model, delegates provider and disposes", async () => {
  const calls: any[] = []; let service: any; let cleanup: any;
  const runtime = { async open(key: string, options: unknown) {
    calls.push({ key, options });
    return { async prompt(text: string, options: unknown) { calls.push({ text, options }); return "Reported lesson"; },
      async dispose() { calls.push("disposed"); }, async abort() {} };
  } } as unknown as AgentRuntime;
  const memory = { async recall() { return "recall"; }, async capture() {}, provider: { async put(ctx: unknown, entry: unknown) { calls.push({ ctx, entry }); } } };
  const plugin = memoryConsolidationHost({ tier: "local", model: "cheap/local" }, runtime, memory as any, () => {});
  await plugin.activate({ registerService(name: string, version: number, impl: unknown) { assert.equal(name, "memory-consolidation"); assert.equal(version, 1); service = impl; }, onStop(fn: unknown) { cleanup = fn; } } as unknown as PluginAPI);
  assert.equal(await service.summarize({ sessionKey: "private", requestId: "one", instruction: "Summarize", sources: [{ reply: "untrusted" }] }), "Reported lesson");
  assert.deepEqual(calls[0].options, { ephemeral: true });
  assert.ok(!calls[0].key.includes("private"));
  assert.deepEqual(calls[1].options, { model: "cheap/local", thinking: "off" });
  assert.equal(calls[2], "disposed");
  await service.put({ sessionKey: "private" }, { key: "one" });
  assert.equal(calls[3].ctx.sessionKey, "private");
  await cleanup();
  assert.throws(() => service.summarize({}), /stopped/);
});

for (const mode of ["timeout", "shutdown", "opening-timeout", "opening-shutdown", "open-error"] as const) {
  test(`isolated worker ${mode} rejects without publishing and safely disposes`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let service: any, cleanup: any, releaseOpen: any, releasePrompt: any;
    let disposed = 0, aborted = 0, prompted = 0, writes = 0;
    const opening = mode.startsWith("opening-");
    const session = {
      async prompt() { prompted++; return new Promise<string>(resolve => { releasePrompt = resolve; }); },
      async abort() { aborted++; releasePrompt?.("partial output"); },
      async dispose() { disposed++; },
    };
    const runtime = { async open() {
      if (mode === "open-error") throw Error("open failed");
      if (opening) await new Promise<void>(resolve => { releaseOpen = resolve; });
      return session;
    } } as unknown as AgentRuntime;
    const memory = { async recall() { return ""; }, async capture() {}, provider: { async put() { writes++; } } };
    await memoryConsolidationHost({ tier: "frontier", model: "test/cheap", timeoutMs: 1000 }, runtime, memory as any, () => {}).activate({
      registerService(_n: string, _v: number, value: unknown) { service = value; },
      onStop(fn: unknown) { cleanup = fn; },
    } as unknown as PluginAPI);
    const work = service.summarize({ sessionKey: "scope", requestId: "one", instruction: "Summarize", sources: [] });
    const rejected = assert.rejects(work, mode === "open-error" ? /open failed/ : /cancelled|timed out/);
    await Promise.resolve();
    let stopping: Promise<void> | undefined;
    if (mode.includes("shutdown")) stopping = cleanup();
    else if (mode.includes("timeout")) t.mock.timers.tick(1000);
    releaseOpen?.();
    await rejected;
    await stopping;
    await cleanup();
    assert.equal(writes, 0);
    assert.equal(disposed, mode === "open-error" ? 0 : 1);
    assert.equal(prompted, opening || mode === "open-error" ? 0 : 1);
    assert.equal(aborted, opening || mode === "open-error" ? 0 : 1);
    assert.throws(() => service.summarize({}), /stopped/);
  });
}
