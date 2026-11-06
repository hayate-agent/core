// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeCompaction } from "../src/compaction.js";
import { PiSession } from "../src/runtime/pi.js";
import { defaultConfig } from "../src/config.js";

test("native compaction delegates without replacing runtime semantics", async () => {
  let received: string | undefined;
  await nativeCompaction.compact({ instructions: "Keep decisions", compactNative: async (text) => { received = text; } });
  assert.equal(received, "Keep decisions");
  assert.equal(defaultConfig().sessions?.provider, "native");
  assert.equal(defaultConfig().compaction?.strategy, "native");
  assert.throws(() => defaultConfig({ compaction: { strategy: "" } }), /Invalid compaction/);
});

test("session compaction strategy wraps native compaction and persists only after success", async () => {
  const calls: string[] = [];
  const agent = { compact: async (text: string) => { calls.push(text); } };
  const session = new PiSession(agent as any, {} as any, {}, async () => { calls.push("checkpoint"); }, undefined, {
    compact: async ({ compactNative, instructions }) => { await compactNative(`Policy: ${instructions}`); },
  });
  await session.compact("retain tasks");
  assert.deepEqual(calls, ["Policy: retain tasks", "checkpoint"]);
});
