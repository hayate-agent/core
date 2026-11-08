import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MatrixCrypto } from "../src/builtin-plugins/matrix-crypto.js";
import { MatrixChannel, matrixOptionsFromEnv } from "../src/builtin-plugins/matrix-channel.js";

test("real encrypted channel preserves ACL/envelope/threads, delayed keys survive restart and all sends fail closed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "matrix-channel-crypto-"));
  const devices: Record<string, any> = {}, keys: Record<string, any> = {}, inbox: Record<string, any[]> = {};
  let failKeys = false;
  const api = (sender: string) => async (_method: string, p: string, body?: any) => {
    if (failKeys) throw Error("key server unavailable");
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
  let syncResponse: any = { next_batch: "initial" };
  let encryptedRoom = true, sendFailure = false;
  const sent: any[] = [];
  let mediaBytes: Buffer;
  const fetcher = (async (url: string, init: RequestInit) => {
    const p = new URL(url).pathname.replace("/_matrix/client/v3", "");
    let out: any;
    if (p === "/_matrix/media/v3/upload") { mediaBytes = Buffer.from(init.body as any); out = { content_uri: "mxc://example.org/media" }; }
    else if (p === "/_matrix/client/v1/media/download/example.org/media") return new Response(new Uint8Array(mediaBytes));
    else if (p === "/account/whoami") out = { user_id: bobId, device_id: "BOB" };
    else if (p === "/sync") out = syncResponse;
    else if (p.endsWith("/state/m.room.encryption")) {
      if (!encryptedRoom) return new Response("{}", { status: 404 });
      out = { algorithm: "m.megolm.v1.aes-sha2" };
    } else if (p.endsWith("/joined_members")) out = { joined: { [aliceId]: {}, [bobId]: {} } };
    else if (p.includes("/receipt/")) out = {};
    else if (p.includes("/event/")) out = { type: "m.room.encrypted", content: sent[0]?.content };
    else if (p.includes("/send/")) { if (sendFailure) return new Response("{}", { status: 503 }); sent.push({ p, content: JSON.parse(String(init.body)) }); out = { event_id: "$out" }; }
    else out = await api(bobId)(init.method!, p, init.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(out));
  }) as typeof fetch;
  const options = { ...matrixOptionsFromEnv({ MATRIX_HOMESERVER: "https://example.org", MATRIX_ACCESS_TOKEN: "test", MATRIX_ALLOWED_USERS: aliceId, MATRIX_TEXT_BATCH_DELAY_SECONDS: "0" }, path.join(dir, "channel"))!, fetch: fetcher, log: () => {} };
  const received: any[] = [];
  const channel = () => { const c = new MatrixChannel(options); (c as any).run = async () => {}; return c; };
  let ch = channel();
  const alice = await MatrixCrypto.open(path.join(dir, "alice"), "https://example.org", aliceId, "ALICE", api(aliceId));
  try {
    await alice.sync({}); await ch.start(async input => { received.push(input); });
    const content = { msgtype: "m.text", body: "private", "m.relates_to": { rel_type: "m.thread", event_id: "$root" } };
    const encrypted = await alice.encrypt(room, "m.room.message", content, [aliceId, bobId]);
    const event = { type: "m.room.encrypted", sender: aliceId, event_id: "$delayed", origin_server_ts: 1, content: encrypted };
    syncResponse = { next_batch: "delayed", rooms: { join: { [room]: { timeline: { events: [event] } } } } };
    await ch.syncOnce(); assert.equal(received.length, 0);
    assert.match(await readFile(path.join(dir, "channel/matrix-crypto/pending-events.json"), "utf8"), /\$delayed/);
    await ch.stop(); ch = channel(); await ch.start(async input => { received.push(input); });
    syncResponse = { next_batch: "keys", to_device: { events: inbox[bobId] } };
    await ch.syncOnce();
    assert.equal(received.length, 1); assert.equal(received[0].id, "$delayed"); assert.equal(received[0].sender, aliceId);
    assert.equal(received[0].replyTo.thread, "$root"); assert.equal(received[0].text, "private");
    const stranger = await alice.encrypt(room, "m.room.message", { msgtype: "m.text", body: "/pause" }, [aliceId, bobId]);
    assert.notEqual(stranger.session_id, encrypted.session_id);
    syncResponse = { next_batch: "forged", to_device: { events: inbox[bobId] }, rooms: { join: { [room]: { timeline: { events: [{ ...event, sender: "@stranger:example.org", event_id: "$forged", content: stranger }] } } } } };
    await ch.syncOnce(); assert.equal(received.length, 1);
    syncResponse = { next_batch: "plain", rooms: { join: { [room]: { timeline: { events: [{ ...event, event_id: "$plain", type: "m.room.message", content: { msgtype: "m.text", body: "/pause" } }] } } } } };
    await ch.syncOnce(); assert.equal(received.length, 1, "plaintext command in encrypted room is rejected");
    await ch.send({ channel: "matrix", target: room, thread: "$root" }, "secret reply", { deliveryId: "reply" });
    assert.match(sent[0].p, /\/send\/m.room.encrypted\/reply.0$/);
    assert.equal(JSON.stringify(sent).includes("secret reply"), false);
    await alice.sync({ to_device: { events: inbox[aliceId] } });
    const outgoing = await alice.decrypt(room, { ...event, sender: bobId, event_id: "$out", content: sent[0].content });
    assert.equal(outgoing.content.body, "secret reply"); assert.equal(outgoing.content["m.relates_to"].event_id, "$root");
    await ch.send({ channel: "matrix", target: room }, "progress", { progressId: "p", presentation: "progress" });
    await ch.send({ channel: "matrix", target: room }, "final", { progressId: "p" });
    assert.ok(sent.every(s => s.p.includes("/send/m.room.encrypted/")), "progress seeds and edits are encrypted too");
    const attachment = path.join(dir, "private.txt");
    await writeFile(attachment, "secret attachment");
    await ch.send({ channel: "matrix", target: room, thread: "$root" }, `MEDIA:${attachment}`, { deliveryId: "media" });
    const mediaEvent = sent.at(-1)!;
    assert.match(mediaEvent.p, /\/send\/m.room.encrypted\/media.media.0$/);
    assert.equal(mediaBytes!.includes(Buffer.from("secret attachment")), false);
    await alice.sync({ to_device: { events: inbox[aliceId] } });
    const mediaPlain = await alice.decrypt(room, { ...event, sender: bobId, event_id: "$media-out", content: mediaEvent.content });
    assert.equal(mediaPlain.content.file.v, "v2");
    assert.equal(mediaPlain.content["m.relates_to"].event_id, "$root");
    const returned = await alice.encrypt(room, "m.room.message", mediaPlain.content, [aliceId, bobId]);
    syncResponse = { next_batch: "media", to_device: { events: inbox[bobId] }, rooms: { join: { [room]: { timeline: { events: [{ ...event, event_id: "$media-in", content: returned }] } } } } };
    await ch.syncOnce();
    const localFile = JSON.parse(received.at(-1).text.match(/untrusted\): (.*)\]/)![1]).path;
    assert.equal(await readFile(localFile, "utf8"), "secret attachment");
    sendFailure = true; await assert.rejects(ch.send({ channel: "matrix", target: room }, "never cleartext"));
    failKeys = true;
    await assert.rejects(ch.send({ channel: "matrix", target: room }, "no keys no downgrade"));
    encryptedRoom = false; (ch as any).crypto.close(); (ch as any).crypto = undefined;
    await assert.rejects(ch.send({ channel: "matrix", target: room }, "disabled"), /plaintext downgrade/);
  } finally { await ch.stop(); alice.close(); await rm(dir, { recursive: true, force: true }); }
});
