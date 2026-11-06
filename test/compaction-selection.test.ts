// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { CompactionSelection } from "../src/compaction.js";
import { PiSession } from "../src/runtime/pi.js";

test("already-open session follows new registered selection only on next operation; native restore and checkpoint remain real", async () => {
  const calls: string[] = [];
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const registry = new Map([
    ["held", { compact: async ({ compactNative }: any) => { entered(); await gate; await compactNative("held"); } }],
    ["next", { compact: async ({ compactNative }: any) => { await compactNative("next"); } }],
  ]);
  const selected = new CompactionSelection(registry, "native");
  const session = new PiSession({ compact: async (text: string) => { calls.push(text); return { summary: "summary" }; } } as any,
    {} as any, {}, async () => { calls.push("checkpoint"); }, undefined, selected);
  await selected.change("held", async () => {});
  const pending = session.compact("request"); await started;
  try { await assert.rejects(selected.change("next", async () => {}), /Compaction strategy busy/); }
  finally { release(); await pending; }
  assert.deepEqual(calls, ["held", "checkpoint"]);
  await selected.change("next", async () => {}); await session.compact();
  assert.deepEqual(calls.slice(-2), ["next", "checkpoint"]);
  await assert.rejects(selected.change("missing", async () => { throw Error("must not save"); }), /Unknown compaction/);
  await assert.rejects(selected.change("native", async () => { throw Error("save failed"); }), /save failed/);
  assert.equal(selected.active, "next");
  await selected.change(undefined, async () => {}); assert.equal(selected.active, "native");
  await session.compact("native request"); assert.deepEqual(calls.slice(-2), ["native request", "checkpoint"]);
  await selected.change("next", async () => {});
  assert.equal(await session.summarize("summary request"), "summary");
  assert.deepEqual(calls.slice(-2), ["summary request", "checkpoint"], "summary does not use optional compact wrapper");
});
