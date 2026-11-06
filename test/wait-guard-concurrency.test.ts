import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { toolGuardDenialReason, ToolGuardError } from "../src/tool-guard-error.js";
import { FakeRuntime, MemoryChannel } from "./fakes.js";

test("concurrent productive tools both wait for the persisted charge barrier", async () => {
  const key = "mem:room1";
  const runtime = new FakeRuntime();
  const open = runtime.open.bind(runtime);
  let checked = false;
  runtime.open = async (...args) => {
    const session = await open(...args);
    session.prompt = async () => {
      let release!: () => void;
      h.onStateChange = () => new Promise<void>(resolve => { release = resolve; });
      let effects = 0;
      const a = h.guardWaitTool(key, "bash", {}).then(() => { effects++; });
      const b = h.guardWaitTool(key, "plugin_dispatch", { action: "submit" }).then(() => { effects++; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(effects, 0);
      release(); await Promise.all([a, b]);
      assert.equal(effects, 2); assert.equal(h.state(key).task!.depth, 20);
      h.onStateChange = async () => {};
      h.planContinuation(key, { state: "completed" });
      checked = true;
      return "NO_REPLY";
    };
    return session;
  };
  const h = new Harness({ runtime, now: () => 61000 }); h.addChannel(new MemoryChannel());
  h.onStateChange = async () => {};
  h.restoreSessions([{ key, task: { id: "task", original: "Authorized work", state: "waiting", next: "Check status", depth: 19,
    wait: { reason: "dependency", nextAt: 61000, deadline: 301000 } } }]);
  try { await h.tick(); await h.drained(); assert.ok(checked); }
  finally { await h.stop(0); }
});

test("productive exhaustion has a safe actionable machine reason, not generic operator alarm", () => {
  const reason = toolGuardDenialReason(new ToolGuardError("continuation_budget_exhausted", "never forward secrets"));
  assert.match(reason, /^continuation_budget_exhausted:/);
  assert.match(reason, /no work tool was executed/);
  assert.match(reason, /fixed deadline/);
  assert.doesNotMatch(reason, /secrets|Operatorprüfung/);
});
