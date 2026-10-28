import test from "node:test";
import assert from "node:assert/strict";
import { capabilityContext } from "../src/capability-context.js";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
const facts = { revision: 1, sessionKey: "mem:room1", selectedTools: undefined,
  registeredTools: ["plugin_dispatch", "plugin_subagent", "plugin_review"],
  dispatcherEnabled: true, dispatcherReady: true, reviewInstructions: "Dedicated review is mandatory" };
const data = (text: string) => JSON.parse(text.slice(text.indexOf('{')));

test("configured, ready, exposed and session-allowed are separate host facts", () => {
  assert.equal(data(capabilityContext(facts)).dispatcher.sessionAllowed, true);
  assert.equal(data(capabilityContext({...facts,dispatcherReady:false})).dispatcher.sessionAllowed, false);
  assert.equal(data(capabilityContext({...facts,selectedTools:[]})).dispatcher.exposed, false);
  assert.equal(data(capabilityContext({...facts,sessionKey:"dispatch:child"})).dispatcher.sessionAllowed, false);
  assert.equal(data(capabilityContext({...facts,dispatcherEnabled:false})).delegationPolicy, "dedicated-subagent");
});
test("mandatory instructions and fresh capability facts reach working turns without skill context", async () => {
  const runtime = new FakeRuntime(); let revision = 1;
  const h = new Harness({runtime,tickMs:60000,capabilityContext: input => capabilityContext({...facts,sessionKey:input.sessionKey,revision})});
  h.addChannel(new MemoryChannel());h.onStateChange=async()=>{};
  try {
    await h.submit(msg("first"));await h.drained();revision=2;
    await h.submit(msg("second"));await h.drained();
    const opts=runtime.sessions.get("mem:room1")!.options;
    assert.match(opts[0].instructions!,/Dedicated review is mandatory/);
    assert.equal(data(opts[0].instructions!).revision,1);
    assert.equal(data(opts[1].instructions!).revision,2);
  }finally{await h.stop(0);}
});
