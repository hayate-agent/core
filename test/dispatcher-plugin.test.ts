import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginHost } from "../src/plugins.js";
import type { DispatcherStrategy } from "../src/dispatcher.js";
const context = { home: "/tmp", cwd: "/tmp", agent: "fixture" };

test("dispatcher strategies preserve class receiver and freeze registration metadata", async t => {
  const host = new PluginHost();
  t.after(() => host.stop());
  class Strategy {
    name = "example";
    version = 1;
    replaySafe = false;
    #result = "answer";
    async execute() { return this.#result; }
  }
  const strategy = new Strategy();
  let register!: (value: DispatcherStrategy) => void;
  await host.load([], context, [], [], [{ apiVersion: 1, activate(api) {
    register = api.registerDispatcher;
    api.registerDispatcher(strategy);
  } }]);
  strategy.replaySafe = true;
  const registered = host.dispatchers.get("example")!;
  assert.equal(registered.replaySafe, false);
  assert.equal(await registered.execute({} as never, {} as never), "answer");
  assert.throws(() => register(strategy), /closed/);
});

test("decision boundary is an explicit validated host strategy opt-in with bound receiver", async t => {
  const host = new PluginHost(); t.after(() => host.stop());
  class Strategy {
    name = "decisions"; version = 1; replaySafe = false;
    #safe = "retained assessment";
    decisionBoundary(task: { checkpoint?: string }) { return task.checkpoint === this.#safe; }
    async execute() { return "done"; }
  }
  await host.load([], context, [], [], [{ apiVersion: 1, activate(api) { api.registerDispatcher(new Strategy()); } }]);
  const strategy = host.dispatchers.get("decisions")!;
  assert.equal(strategy.decisionBoundary!({ checkpoint: "retained assessment" } as never), true);
  assert.equal(strategy.decisionBoundary!({ checkpoint: "ambiguous intent" } as never), false);
  const invalid = new PluginHost();
  await assert.rejects(invalid.load([], context, [], [], [{ apiVersion: 1, activate(api) {
    api.registerDispatcher({ name: "invalid", version: 1, replaySafe: false, execute: async () => "done", decisionBoundary: true } as never);
  } }]), /Invalid dispatcher strategy/);
});

test("built-in direct strategy name cannot be registered by plugins", async () => {
  const host = new PluginHost();
  await assert.rejects(host.load([], context, [], [], [{ apiVersion: 1, activate(api) {
    api.registerDispatcher({ name: "direct", version: 1, replaySafe: false, execute: async () => "answer" });
  } }]), /Dispatcher conflict: direct/);
  assert.equal(host.dispatchers.size, 0);
});

test("duplicate dispatcher registration rolls back all strategies", async () => {
  const host = new PluginHost();
  const strategy = { name: "example", version: 1, replaySafe: false, execute: async () => "answer" };
  await assert.rejects(host.load([], context, [], [], [{ apiVersion: 1, activate(api) {
    api.registerDispatcher(strategy);
    api.registerDispatcher(strategy);
  } }]), /conflict/);
  assert.equal(host.dispatchers.size, 0);
});
