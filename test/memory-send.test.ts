// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { LocalMemory } from "../src/memory-local.js";
import { memoryConfig } from "../src/memory.js";

for (const mode of ["throw", "callback"] as const) {
  test(`memory IPC ${mode} failure releases request slots and timers`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new EventEmitter() as any;
    const error = Error("synthetic send failure");
    let sends = 0;
    child.send = (_message: unknown, callback: (err: Error) => void) => {
      sends++;
      if (mode === "throw") throw error;
      callback(error);
    };
    const memory = new (LocalMemory as any)(child, memoryConfig());
    for (let n = 0; n < 70; n++) {
      await assert.rejects(memory.status(), mode === "throw" ? /synthetic send failure/ : /disconnected/);
      assert.equal(memory.pending.size, 0, "failed sends must immediately release the bounded queue");
    }
    assert.equal(sends, 70);
    // A healthy subsequent request must still work, and late send callbacks must not
    // change its settlement or disturb another request.
    child.send = (message: any, callback: (err?: Error) => void) => {
      child.emit("message", { id: message.id, value: "synthetic status" });
      callback();
    };
    assert.equal(await memory.status(), "synthetic status");
    assert.equal(memory.pending.size, 0);
    t.mock.timers.tick(30000);
    assert.equal(memory.pending.size, 0);
    child.emit("exit", 0);
  });
}
