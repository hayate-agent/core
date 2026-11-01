import test from "node:test";
import assert from "node:assert/strict";
import { Harness } from "../src/harness.js";
import { FakeRuntime, MemoryChannel, msg } from "./fakes.js";
import { observeSessionChanges } from "../src/session-observer.js";

test("owner snapshot responds during a held prompt without opening another session or exposing content", async () => {
  const runtime = new FakeRuntime();
  const h = new Harness({ runtime, tickMs: 60000 });
  h.addChannel(new MemoryChannel()); h.onStateChange = async () => {};
  let release: (() => void) | undefined;
  try {
    assert.equal(h.observeSession("missing"), undefined);
    assert.equal(h.sessions.size, 0);
    await h.sessionFor("mem:room1");
    release = runtime.sessions.get("mem:room1")!.hold();
    await h.submit(msg("SECRET_INPUT"));
    while (!runtime.sessions.get("mem:room1")!.busy) await new Promise(r => setImmediate(r));
    const controller = new AbortController();
    const stream = observeSessionChanges(h, "mem:room1", controller.signal, 10);
    const first = await stream.next();
    assert.equal(first.value?.running, true);
    controller.abort();
    assert.equal((await stream.next()).done, true);
    const snapshot = h.observeSession("mem:room1")!;
    assert.equal(snapshot.running, true);
    assert.equal(snapshot.prompting, true);
    assert.equal(snapshot.queued, 0);
    assert.equal(runtime.opened.length, 1);
    assert.ok(!JSON.stringify(snapshot).includes("SECRET_INPUT"));
    snapshot.tasks.active = 999;
    assert.notEqual(h.observeSession("mem:room1")!.tasks.active, 999);
    assert.equal(runtime.sessions.get("mem:room1")!.aborted, 0);
    release(); await h.drained();
    assert.equal(h.observeSession("mem:room1")!.running, false);
    assert.equal(runtime.opened.length, 1);
  } finally { release?.(); await h.stop(1000); }
});
