import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { LocalMemory } from "../src/memory-local.js";
import { memoryConfig } from "../src/memory.js";

function fake() {
  const child = new EventEmitter() as any;
  child.exitCode = null; child.signalCode = null;
  const signals: string[] = [];
  child.send = (message: any, callback: any) => {
    callback(null);
    queueMicrotask(() => child.emit("message", { id: message.id, value: undefined }));
  };
  child.kill = (signal: string) => { signals.push(signal); return true; };
  return { child, signals, memory: new (LocalMemory as any)(child, memoryConfig()) as LocalMemory };
}
test("concurrent memory closes share one request and lifecycle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, signals, memory } = fake();
  const requests: any[] = [];
  child.send = (message: any, callback: any) => { requests.push(message); callback(null); };
  const first = memory.close(); const second = memory.close();
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  child.emit("message", { id: requests[0].id, value: undefined });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(signals, ["SIGTERM"]);
  child.exitCode = 0; child.emit("exit", 0);
  await Promise.all([first, second]);
  assert.equal(memory.close(), first);
  t.mock.timers.tick(30000);
  assert.deepEqual(signals, ["SIGTERM"]);
});

test("memory close cancels escalation when worker exits", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, signals, memory } = fake();
  child.kill = (signal: string) => {
    signals.push(signal);
    if (signal === "SIGTERM") queueMicrotask(() => { child.exitCode = 0; child.emit("exit", 0); });
    return true;
  };
  await memory.close();
  t.mock.timers.tick(2000); await Promise.resolve();
  assert.deepEqual(signals, ["SIGTERM"]);
});
test("memory close does not signal a worker that already exited", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { child, signals, memory } = fake();
  child.exitCode = 0; child.emit("exit", 0);
  const closing = memory.close().catch(() => undefined);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(2000); await closing;
  assert.deepEqual(signals, []);
});
test("memory close escalates once for an unresponsive worker", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { signals, memory } = fake();
  const closing = memory.close();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.deepEqual(signals, ["SIGTERM"]);
  t.mock.timers.tick(2000); await closing;
  t.mock.timers.tick(30000);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
