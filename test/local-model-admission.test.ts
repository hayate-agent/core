import test from "node:test";
import assert from "node:assert/strict";
import { LocalModelAdmission, validateLocalModelScheduling } from "../src/local-model-admission.js";
import { defaultConfig } from "../src/config.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("configured concurrency validates fail-closed and remains installation-only", () => {
  for (const bad of [null, {}, [{ model: "x", concurrency: 1 }], [{ model: "p/m", concurrency: 0 }],
    [{ model: "p/m", concurrency: 33 }], [{ model: "p/m", concurrency: 1, unknown: true }],
    [{ model: "p/m", concurrency: 1 }, { model: "p/m", concurrency: 2 }]]) {
    assert.throws(() => validateLocalModelScheduling(bad), /localModelScheduling/);
  }
  assert.equal(defaultConfig().localModelScheduling, undefined);
  assert.deepEqual(defaultConfig({ localModelScheduling: [{ model: "p/m", concurrency: 1 }] }).localModelScheduling,
    [{ model: "p/m", concurrency: 1 }]);
});

test("queue prefers a human waiting behind running background without preempting or replaying either", async () => {
  const gate = new LocalModelAdmission(), order: string[] = [];
  const original = await gate.acquire("same physical endpoint", 1, false);
  const background = gate.acquire("same physical endpoint", 1, false).then(release => { order.push("background"); return release; });
  const human = gate.acquire("same physical endpoint", 1, true).then(release => { order.push("human"); return release; });
  await tick(); assert.deepEqual(order, []);
  original(); const humanRelease = await human;
  assert.deepEqual(order, ["human"]); humanRelease(); humanRelease();
  const backgroundRelease = await background; assert.deepEqual(order, ["human", "background"]); backgroundRelease();
});

test("cancelled waiting acquisition sends nothing, does not leak a slot and cannot revoke a granted permit", async () => {
  const gate = new LocalModelAdmission(), first = await gate.acquire("physical", 1, false), abort = new AbortController();
  const waiting = gate.acquire("physical", 1, true, abort.signal);
  abort.abort(); await assert.rejects(waiting);
  const second = gate.acquire("physical", 1, false); first(); const release = await second;
  const runningAbort = new AbortController(); release();
  const granted = await gate.acquire("physical", 1, true, runningAbort.signal); runningAbort.abort();
  let thirdStarted = false;
  const third = gate.acquire("physical", 1, false).then(r => { thirdStarted = true; return r; });
  await tick(); assert.equal(thirdStarted, false, "a running response owns its permit until settlement, even after abort signal");
  granted(); (await third)();
});

test("independent models retain independent capacity and bounded foreground bursts do not starve background", async () => {
  const gate = new LocalModelAdmission(), original = await gate.acquire("a", 1, false), other = await gate.acquire("b", 1, false);
  other(); const order: string[] = [];
  const background = gate.acquire("a", 1, false).then(r => { order.push("background"); r(); });
  const foreground = Array.from({ length: 6 }, (_, i) => gate.acquire("a", 1, true).then(r => { order.push(`human${i}`); r(); }));
  original(); await Promise.all([background, ...foreground]);
  assert.deepEqual(order, ["human0", "human1", "human2", "human3", "background", "human4", "human5"]);
});

test("uncontended human traffic does not spend a future background waiter's fairness burst", async () => {
  const gate = new LocalModelAdmission();
  for (let i = 0; i < 8; i++) (await gate.acquire("a", 1, true))();
  const original = await gate.acquire("a", 1, true), order: string[] = [];
  const background = gate.acquire("a", 1, false).then(r => { order.push("background"); r(); });
  const human = gate.acquire("a", 1, true).then(r => { order.push("human"); r(); });
  original(); await Promise.all([background, human]); assert.deepEqual(order, ["human", "background"]);
});

test("same physical model cannot silently acquire conflicting limits", async () => {
  const gate = new LocalModelAdmission(), release = await gate.acquire("same", 1, false);
  assert.throws(() => gate.acquire("same", 2, false), /Conflicting/); release();
});
