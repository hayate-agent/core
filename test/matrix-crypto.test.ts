// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MatrixCrypto } from "../src/builtin-plugins/matrix-crypto.js";

test("real Olm/Megolm exchange, delayed key delivery and durable reopen", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matrix-crypto-"));
  const devices: Record<string, any> = {}, keys: Record<string, any> = {}, inbox: Record<string, any[]> = {};
  const api = (sender: string) => async (_method: string, p: string, body?: any) => {
    if (p === "/keys/upload") {
      if (body.device_keys) devices[sender] = body.device_keys;
      keys[sender] = { ...keys[sender], ...body.one_time_keys };
      return { one_time_key_counts: { signed_curve25519: Object.keys(keys[sender]).length } };
    }
    if (p === "/keys/query") return { device_keys: Object.fromEntries(Object.keys(body.device_keys).map(u => [u, devices[u] ? { [devices[u].device_id]: devices[u] } : {}])) };
    if (p === "/keys/claim") return { one_time_keys: Object.fromEntries(Object.entries<any>(body.one_time_keys).map(([u, ds]) => [u, Object.fromEntries(Object.keys(ds).map(d => {
      const k = Object.keys(keys[u] ?? {})[0]; const value = k ? { [k]: keys[u][k] } : {}; if (k) delete keys[u][k]; return [d, value];
    }))])) };
    if (p.startsWith("/sendToDevice/")) { for (const [u, ds] of Object.entries<any>(body.messages)) for (const content of Object.values(ds)) (inbox[u] ??= []).push({ sender, type: decodeURIComponent(p.split("/")[2]), content }); return {}; }
    throw Error(`Unexpected crypto request ${p}`);
  };
  const aliceId = "@alice:example.org", bobId = "@bob:example.org", room = "!room:example.org";
  let alice: MatrixCrypto | undefined, bob: MatrixCrypto | undefined;
  try {
    alice = await MatrixCrypto.open(path.join(dir, "alice"), "https://example.org", aliceId, "ALICE", api(aliceId));
    bob = await MatrixCrypto.open(path.join(dir, "bob"), "https://example.org", bobId, "BOB", api(bobId));
    await alice.sync({}); await bob.sync({});
    const content = { msgtype: "m.text", body: "private", "m.relates_to": { rel_type: "m.thread", event_id: "$root" } };
    const encrypted = await alice.encrypt(room, "m.room.message", content, [aliceId, bobId]);
    assert.equal(JSON.stringify(encrypted).includes("private"), false);
    const event = { type: "m.room.encrypted", sender: aliceId, event_id: "$message", origin_server_ts: 1, content: encrypted };
    await assert.rejects(bob.decrypt(room, event));
    await bob.sync({ to_device: { events: inbox[bobId] } });
    assert.deepEqual((await bob.decrypt(room, event)).content, content);
    bob.close(); bob = await MatrixCrypto.open(path.join(dir, "bob"), "https://example.org", bobId, "BOB", api(bobId));
    assert.deepEqual((await bob.decrypt(room, event)).content, content);
    await assert.rejects(MatrixCrypto.open(path.join(dir, "bob"), "https://evil.org", bobId, "BOB", api(bobId)), /identity/);
    const afterLeave = await alice.encrypt(room, "m.room.message", { body: "departed member cannot read" }, [aliceId]);
    assert.notEqual(afterLeave.session_id, encrypted.session_id);
    await assert.rejects(bob.decrypt(room, { ...event, event_id: "$after-leave", content: afterLeave }));
    const identity = JSON.stringify(devices[aliceId]);
    alice.close(); alice = await MatrixCrypto.open(path.join(dir, "alice"), "https://example.org", aliceId, "ALICE", api(aliceId));
    await alice.sync({ device_lists: { changed: [bobId], left: [] }, device_one_time_keys_count: { signed_curve25519: 0 }, device_unused_fallback_key_types: [] });
    assert.equal(JSON.stringify(devices[aliceId]), identity, "sender keeps original device identity after reopen");
    const afterRestart = await alice.encrypt(room, "m.room.message", content, [aliceId, bobId]);
    await bob.sync({ to_device: { events: inbox[bobId] }, device_lists: { changed: [aliceId], left: [] } });
    assert.deepEqual((await bob.decrypt(room, { ...event, event_id: "$restart", content: afterRestart })).content, content);
    assert.equal((await stat(path.join(dir, "bob"))).mode & 0o777, 0o700);
  } finally { alice?.close(); bob?.close(); await rm(dir, { recursive: true, force: true }); }
});
