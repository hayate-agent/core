import assert from "node:assert/strict";
import { test } from "node:test";
import { PluginHost } from "../src/plugins.js";
import { Dispatcher, type DispatcherStrategy } from "../src/dispatcher.js";
import { getJsonSchemaToolParameters } from "@earendil-works/pi-ai/api/constrained-sampling";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { dispatcherPlugin } from "../src/builtin-plugins/dispatcher-plugin.js";
const context = { home: "/tmp", cwd: "/tmp", agent: "fixture" };

test("dispatcher controls accept minimal resume with optional requestId without accepting steering", async () => {
  const calls: unknown[][] = [];
  let tool: any;
  const plugin = dispatcherPlugin(() => ({ control: async (...args: unknown[]) => { calls.push(args); } }) as any);
  await plugin.activate({ registerTool: (value: any) => { tool = value; }, registerCommand: () => {} } as any);
  assert.deepEqual(tool.parameters.required, ["action"]);
  const run = (input: Record<string, unknown>, sessionKey = "parent") => tool.execute(input, { sessionKey });
  assert.equal(await run({ action: "resume", id: "existing", requestId: "resume-once" }), "Control recorded");
  assert.deepEqual(calls, [["parent", "existing", "resume"]]);
  for (const action of ["pause", "resume", "cancel"]) {
    await run({ action, id: "existing" });
    await run({ action, id: "existing", requestId: "control-once" });
  }
  const accepted = calls.length;
  for (const extra of ["task", "taskId", "questionId", "answer", "decision", "offset", "limit", "field", "charOffset", "unknown"]) {
    await assert.rejects(run({ action: "resume", id: "existing", requestId: "resume-once", [extra]: "steering" }), /Control does not accept/);
    await assert.rejects(run({ action: "resume", id: "existing", [extra]: null }), /Control does not accept/);
  }
  for (const requestId of [null, 12, {}, "", "   "]) {
    await assert.rejects(run({ action: "resume", id: "existing", requestId }), /Invalid control requestId/);
  }
  await assert.rejects(run({ action: "resume", requestId: "resume-once" }), /Invalid dispatch action/);
  await assert.rejects(run({ action: "resume", id: 12 }), /Invalid dispatch action/);
  await assert.rejects(run({ action: "unknown", id: "existing" }), /Invalid dispatch action/);
  await assert.rejects(run({ action: "resume", id: "existing" }, "dispatch:worker"), /Worker delegation/);
  assert.equal(calls.length, accepted, "invalid controls must not reach the dispatcher");
});

test("strict provider control shape normalizes placeholders without bypassing steering or ownership checks", async () => {
  const calls: unknown[][] = [];
  // Exercise the real ownership guard with an isolated store; no live dispatcher.
  const host = {
    store: {
      list: (parent: string) => parent === "parent" ? [{ id: "existing" }] : [],
      control: async (...args: unknown[]) => { calls.push(args); },
    },
    kick: async () => {},
  };
  let tool: any;
  await dispatcherPlugin(() => ({
    control: (parent: string, id: string, action: "pause" | "resume" | "cancel") =>
      Dispatcher.prototype.control.call(host as any, parent, id, action),
  }) as any).activate({ registerTool: (value: any) => { tool = value; }, registerCommand: () => {} } as any);
  const fields = ["action", "requestId", "task", "id", "taskId", "questionId", "answer", "decision", "offset", "limit", "field", "charOffset"];
  const strict = getJsonSchemaToolParameters(tool, true) as any;
  assert.deepEqual([...strict.required].sort(), [...fields].sort());
  const raw = Object.fromEntries(fields.map(key => [key, null]));
  Object.assign(raw, { action: "resume", id: "existing", requestId: "resume-once" });
  const validate = (args: Record<string, unknown>) => validateToolArguments(tool, {
    type: "toolCall", id: "fixture", name: tool.name, arguments: args,
  });
  const args = validate(raw);
  assert.deepEqual(args, { action: "resume", id: "existing", requestId: "resume-once" });
  assert.equal(await tool.execute(args, { sessionKey: "parent" }), "Control recorded");
  assert.deepEqual(calls, [["existing", "resume"]]);
  await assert.rejects(tool.execute(validate(raw), { sessionKey: "other" }), /Unknown execution in this conversation/);
  await assert.rejects(tool.execute(validate({ ...raw, id: "foreign" }), { sessionKey: "parent" }), /Unknown execution in this conversation/);
  for (const [key, value] of Object.entries({ task: "steer", taskId: "foreign", questionId: "q", answer: "yes", decision: "approve", offset: 0, limit: 1, field: "result", charOffset: 0 })) {
    await assert.rejects(tool.execute(validate({ ...raw, [key]: value }), { sessionKey: "parent" }), /Control does not accept/);
  }
  await assert.rejects(tool.execute(validate({ ...raw, authority: "approve" }), { sessionKey: "parent" }), /Control does not accept/);
  await assert.rejects(tool.execute(validate(raw), { sessionKey: "dispatch:worker" }), /Worker delegation/);
  assert.deepEqual(calls, [["existing", "resume"]], "rejected calls must not mutate the store");
  assert.equal(raw.task, null, "validation must not mutate the provider payload");
});

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
