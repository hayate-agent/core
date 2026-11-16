import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Dispatcher } from "../src/dispatcher.js";
import { ExecutionStore } from "../src/execution.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

const gate = () => {
  let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise };
};
const until = async (condition: () => boolean) => {
  for (let i = 0; i < 400 && !condition(); i++) await new Promise(r => setTimeout(r, 5));
  assert(condition(), "fixture condition settled");
};

test("structurally recovered Dispatcher does not hold restored ingress behind a pending scheduling pass", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-startup-ingress-"));
  const entered = gate(), release = gate(); let structuralRecoveries = 0, claims = 0, effects = 0;
  class HeldClaimStore extends ExecutionStore {
    override async recover(...args: Parameters<ExecutionStore["recover"]>) {
      await super.recover(...args); structuralRecoveries++;
    }
    override async claim(...args: Parameters<ExecutionStore["claim"]>) {
      claims++; entered.resolve(); await release.promise; return super.claim(...args);
    }
  }
  const store = new HeldClaimStore(path.join(home, "executions.json")); await store.load();
  await store.submit("old-parent", "old-worker", "retained old work", "fixture");
  const dispatcher = new Dispatcher(store, { name: "fixture", version: 1, replaySafe: false,
    execute: async () => { effects++; return "old work settled"; } }, 1, async () => {}, e => assert.fail(String(e)));
  let modelCalls = 0;
  const harness = new Harness({ runtime: new FakeRuntime(() => { modelCalls++; return "Antwort"; }), tickMs: 60000 });
  const channel = new MemoryChannel(); harness.addChannel(channel);
  harness.restorePending([{ id: "already-accepted-human", sessionKey: "mem:human", source: "channel", text: "Einfache Frage",
    replyTo: { channel: "mem", target: "human" } }]);
  t.after(async () => { release.resolve(); await dispatcher.stop(); await harness.stop(0); await rm(home, { recursive: true, force: true }); });
  await harness.start();
  await dispatcher.start({ schedule: false });
  assert.equal(structuralRecoveries, 1); assert.equal(dispatcher.ready, true);
  assert.equal(claims, 0, "start does not silently begin scheduling when host defers it");
  const scheduling = dispatcher.kick(); await entered.promise;
  harness.releaseRestored();
  await until(() => channel.sent.some(message => message.text === "Antwort"));
  assert.equal(modelCalls, 1, "one original ingress, no new synthetic acceptance or effect replay");
  assert.equal(effects, 0, "old scheduling is still pending; no worker permission was bypassed");
  release.resolve(); await scheduling; await until(() => effects === 1);
});

test("structural recovery failure still fails startup without scheduling or weakening holds", async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), "dispatch-startup-failure-")); t.after(() => rm(home, { recursive: true, force: true }));
  class BrokenRecoveryStore extends ExecutionStore { override async recover(): Promise<void> { throw Error("fixture structural failure"); } }
  const store = new BrokenRecoveryStore(path.join(home, "executions.json")); await store.load(); let effects = 0;
  const dispatcher = new Dispatcher(store, { name: "fixture", version: 1, replaySafe: false, execute: async () => { effects++; return "not admitted"; } },
    1, async () => {}, () => {});
  await assert.rejects(dispatcher.start({ schedule: false }), /fixture structural failure/);
  assert.equal(dispatcher.ready, false); await dispatcher.kick(); assert.equal(effects, 0);
});
