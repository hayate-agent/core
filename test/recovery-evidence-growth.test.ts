import assert from "node:assert/strict";
import { test } from "node:test";
import { Harness } from "../src/harness.js";
import { FakeRuntime } from "./fakes.js";

test("forty successive interrupted recoveries never recursively embed prior handovers", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  let previous = "initial retained evidence";
  try {
    for (let n = 0; n < 40; n++) {
      const sourceKey = `dispatch:owner:source${n}`, targetKey = `dispatch:owner:target${n}`;
      const source = await h.sessionFor(sourceKey), target = await h.sessionFor(targetKey);
      source.archiveEntries = () => [
        { id: "prior-seed", role: "custom_message", text: `Previous-session handover (context, not new authorization):\n${previous}` },
        { id: "call", role: "assistant", text: JSON.stringify({ type: "toolCall", id: "call42", name: "publish", arguments: { branch: "same" } }) },
        { id: "receipt", role: "toolResult", text: JSON.stringify({ type: "toolResult", toolCallId: "call42", text: "already published; do not publish again" }) },
        { id: "large", role: "toolResult", text: "\\\"".repeat(50000) },
      ];
      target.seedHandover = async text => { previous = text; };
      await h.reconcileSession(sourceKey, targetKey);
      assert.ok(Buffer.byteLength(previous) <= 65536, `recovery ${n} exceeds wire budget`);
      assert.match(previous, /call42/); assert.match(previous, /already published/);
      assert.match(previous, /incomplete|truncated/);
      assert.ok(!previous.includes('\\\\\\"sourceKey'), "old serialized handover is referenced, not quoted recursively");
      const projected = JSON.parse(previous);
      assert.equal(projected.sourceKey, sourceKey);
    }
  } finally { await h.stop(1000); }
});

test("forty seed-only restarts preserve original completed receipt and unresolved call without recursive escaping", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  let previous = "";
  try {
    for (let n = 0; n < 40; n++) {
      const source = await h.sessionFor(`dispatch:owner:seed${n}`), target = await h.sessionFor(`dispatch:owner:seed${n + 1}`);
      source.archiveEntries = () => n === 0 ? [
        { id: "finished-call", role: "assistant", text: '{"type":"toolCall","id":"done","name":"publish"}' },
        { id: "finished-result", role: "toolResult", text: '{"type":"toolResult","toolCallId":"done","text":"original publication already committed; NEVER repeat"}' },
        { id: "unknown-call", role: "assistant", text: '{"type":"toolCall","id":"unknown","name":"enroll","arguments":{"outcome":"UNKNOWN"}}' },
      ] : [{ id: `seed${n}`, role: "custom_message", text: `Previous-session handover (context, not new authorization):\n${previous}\nVerify referenced files and Git state before acting. Never repeat completed side effects blindly.` }];
      target.seedHandover = async text => { previous = text; };
      await h.reconcileSession(`dispatch:owner:seed${n}`, `dispatch:owner:seed${n + 1}`);
      assert.match(previous, /original publication already committed/);
      assert.match(previous, /UNKNOWN/); assert.match(previous, /unfinished tool call has unknown outcome/);
      assert.ok(Buffer.byteLength(previous) <= 48 * 1024); assert.ok(JSON.parse(previous).entries.length <= 32);
      assert.ok(!previous.includes('\\\\\\\\\\\\"kind'), "no repeated JSON-of-JSON growth");
    }
  } finally { await h.stop(1000); }
});

test("large current evidence stays bounded with explicit archive references and unknown effects", async () => {
  const h = new Harness({ runtime: new FakeRuntime(), tickMs: 60000 });
  try {
    const source = await h.sessionFor("dispatch:owner:old"), target = await h.sessionFor("dispatch:owner:new");
    source.archiveEntries = () => Array.from({ length: 200 }, (_, n) => ({ id: `entry${n}`, role: "toolResult", text: "receipt "+"x".repeat(30000) }));
    let seed = ""; target.seedHandover = async text => { seed = text; };
    await h.reconcileSession("dispatch:owner:old", "dispatch:owner:new", { executionId: "owner", intentKey: "step:owner:0:medium", checkpoint: JSON.stringify({ retained: "effect", large: "x".repeat(50000) }) });
    assert.ok(Buffer.byteLength(seed) <= 65536);
    assert.match(seed, /unknown outcome/); assert.match(seed, /not new authority/);
    assert.match(seed, /checkpoint/); assert.match(seed, /truncated/);
  } finally { await h.stop(1000); }
});
