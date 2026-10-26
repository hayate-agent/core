import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicyRegistry } from "../src/policies.js";
import { PluginHost } from "../src/plugins.js";
import { reviewPolicy } from "../src/review-policy.js";
import type { ReviewService } from "../src/review.js";
import type { Inbound } from "../src/types.js";
const input: Inbound = { sessionKey: "chat", source: "channel", text: "work" };
const context = { home: "/tmp", cwd: "/tmp", agent: "test" };

test("absent optional policies pass through; registered hooks compose in insertion order", async () => {
  const registry = new PolicyRegistry();
  assert.equal(await registry.finish("/tmp", input, "reply", {} as never, {}), "reply");
  await registry.beforeTool("/tmp", "read", {});
  await registry.assertAllowed("/tmp", "publish");
  const order: string[] = [];
  for (const id of ["first", "second"]) registry.register({ id, async beforeTool() { order.push(id); }, async finish(_cwd, _input, reply) { return reply + ":" + id; } });
  await registry.beforeTool("/tmp", "read", {});
  assert.deepEqual(order, ["first", "second"]);
  assert.equal(await registry.finish("/tmp", input, "reply", {} as never, {}), "reply:first:second");
});

test("class hooks retain prototype methods and receiver; explicit failure stops later hooks", async () => {
  class Hook { id = "class-hook"; calls = 0; async beforeTool() { this.calls++; throw Error("explicit policy rejection"); } }
  const registry = new PolicyRegistry(); const hook = new Hook(); let later = false;
  registry.register(hook);
  registry.register({ id: "later", async beforeTool() { later = true; } });
  await assert.rejects(registry.beforeTool("/tmp", "read", {}), /explicit policy rejection/);
  assert.equal(hook.calls, 1); assert.equal(later, false);
  assert.throws(() => registry.register(hook), /conflict/);
});

test("default review adapter composes once with a plugin policy and preserves origin", async () => {
  const calls: string[] = [];
  const service = {
    config: { enabled: false },
    async prepare(cwd: string, origin: unknown, key: string) {
      assert.equal(cwd, "/tmp"); assert.deepEqual(origin, { channel: "matrix", target: "parent" });
      assert.equal(key, "chat"); calls.push("review-prepare");
    },
    async assertAllowed(_cwd: string, action: string) { calls.push("review-" + action); },
  } as unknown as ReviewService;
  const host = new PluginHost(["review"]);
  host.policies.register(reviewPolicy(service, () => ({ channel: "matrix", target: "parent" })));
  await host.load([], context, [], [], [{ apiVersion: 1, activate(api) {
    api.registerPolicy({ id: "additional", async prepare() { calls.push("plugin-prepare"); },
      async finish(_cwd, _input, reply) { calls.push("plugin-finish"); return reply + "-checked"; } });
  } }]);
  await host.policies.prepare("/tmp", input);
  await host.policies.beforeTool("/tmp", "read", {});
  assert.equal(await host.policies.finish("/tmp", input, "reply", {} as never, {}), "reply-checked");
  await host.policies.assertAllowed("/tmp", "publish");
  assert.deepEqual(calls, ["review-prepare", "plugin-prepare", "plugin-finish", "review-publish"]);
  await host.stop();
});

test("plugin activation validates explicit required identities and clears hooks on failure/stop", async () => {
  const missing = new PluginHost(["review"]);
  await assert.rejects(missing.load([], context, []), /Required policy unavailable/);
  const failed = new PluginHost();
  await assert.rejects(failed.load([], context, [], [], [{ apiVersion: 1, activate(api) {
    api.registerPolicy({ id: "partial", async beforeTool() { throw Error("leaked hook"); } });
    throw Error("activation failed");
  } }]), /activation failed/);
  await failed.policies.beforeTool("/tmp", "read", {});
  const host = new PluginHost(["selected"]);
  await host.load([], context, [], [], [{ apiVersion: 1, activate(api) { api.registerPolicy({ id: "selected", async prepare() {} }); } }]);
  await host.policies.prepare("/tmp", input);
  await host.stop();
  await assert.rejects(host.policies.prepare("/tmp", input), /Required policy unavailable/);
});
