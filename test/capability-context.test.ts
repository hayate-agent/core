import test from "node:test";
import assert from "node:assert/strict";
import { capabilityContext } from "../src/capability-context.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
const facts = { revision: 1, sessionKey: "mem:room1", selectedTools: undefined,
  registeredTools: ["plugin_dispatch", "plugin_subagent", "plugin_review"],
  dispatcherEnabled: true, dispatcherReady: true, reviewInstructions: "Dedicated review is mandatory" };
const data = (text: string) => JSON.parse(text.slice(text.indexOf('{')).split("\n")[0]);

test("configured, ready, exposed and session-allowed are separate host facts", () => {
  assert.equal(data(capabilityContext(facts)).dispatcher.sessionAllowed, true);
  assert.equal(data(capabilityContext({...facts,dispatcherReady:false})).dispatcher.sessionAllowed, false);
  assert.equal(data(capabilityContext({...facts,selectedTools:[]})).dispatcher.exposed, false);
  assert.equal(data(capabilityContext({...facts,sessionKey:"dispatch:child"})).dispatcher.sessionAllowed, false);
  assert.equal(data(capabilityContext({...facts,dispatcherEnabled:false})).preferredDelegationRoute, "dedicated-subagent");
  assert.equal(data(capabilityContext(facts)).preferredDelegationRoute, "dispatcher-worker");
  assert.equal(data(capabilityContext(facts)).delegationPolicy, "dispatcher-worker");
  assert.equal(data(capabilityContext({ ...facts, dispatcherReady: false })).delegationPolicy, "optional");
});
test("Core adds no unconditional review or approval rule when no review engine supplies one", () => {
  for (const sessionKey of ["mem:room1", "dispatch:child", "subagent:child"]) {
    const text = capabilityContext({...facts, sessionKey, reviewInstructions: ""});
    assert.doesNotMatch(text, /ALWAYS|KISS|vertical slices|required review|review is mandatory|small PRs|GitOps|do not merge|own PRs/i);
    assert.equal(data(text).review.registered, true);
  }
  assert.match(capabilityContext(facts), /Dedicated review is mandatory/);
});

test("Main gets direct-answer guidance independently of dispatcher state without changing tool exposure", () => {
  for (const dispatcherEnabled of [false, true]) for (const dispatcherReady of [false, true]) {
    const text = capabilityContext({ ...facts, dispatcherEnabled, dispatcherReady, selectedTools: [],
      dispatcherWorkers: { capacity: 4, active: 4, queued: 9 } });
    if (dispatcherEnabled && dispatcherReady) {
      assert.match(text, /Delegate shell execution and implementation through the ready dispatcher/);
      assert.match(text, /A busy worker is not a broken dispatcher/);
    } else {
      assert.match(text, /delegation is optional, not a prerequisite/);
      assert.match(text, /use your available tools yourself/);
      assert.match(text, /not a single exclusive execution slot/);
      assert.match(text, /grants no unavailable tools, permissions, review exemptions/);
    }
    assert.equal(data(text).dispatcher.exposed, false);
    assert.deepEqual(data(text).dispatcher.workers, { capacity: 4, active: 4, queued: 9 });
  }
  for (const sessionKey of ["dispatch:child", "subagent:child"]) {
    const text = capabilityContext({ ...facts, sessionKey });
    assert.doesNotMatch(text, /Main execution:/);
    assert.equal(data(text).dispatcher.sessionAllowed, false);
  }
});

test("Matrix sessions discover the authorized attachment output protocol", () => {
  const context = capabilityContext({ ...facts, sessionKey: "matrix:!room:example.org" });
  assert.match(context, /MEDIA:\/absolute\/path/);
  assert.match(context, /never upload secrets or files without user authorization/);
  assert.doesNotMatch(capabilityContext(facts), /MEDIA:/);
});

test("selected review instructions and fresh capability facts reach working turns without skill context", async () => {
  const runtime = new FakeRuntime(); let revision = 1;
  const h = new Harness({runtime,tickMs:60000,capabilityContext: input => capabilityContext({...facts,sessionKey:input.sessionKey,revision})});
  h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};
  try {
    await h.submit(msg("first"));await h.drained();revision=2;
    await h.submit(msg("second"));await h.drained();
    const opts=runtime.sessions.get("mem:room1")!.options;
    assert.doesNotMatch(opts[0].instructions!,/ALWAYS vertical slices|ALWAYS KISS/);
    assert.match(opts[0].instructions!,/Dedicated review is mandatory/);
    assert.match(opts[0].instructions!,/Main answers questions and uses native read\/search directly/);
    assert.match(opts[1].instructions!,/Delegate shell execution and implementation through the ready dispatcher/);
    assert.equal(data(opts[0].instructions!).revision,1);
    assert.equal(data(opts[1].instructions!).revision,2);
    assert.doesNotMatch(opts[1].instructions!,/ALWAYS vertical slices|ALWAYS KISS/);
  }finally{await h.stop(0);}
});
