import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, writeFile, stat, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MatrixChannel, matrixOptionsFromEnv } from "../src/builtin-plugins/matrix-channel.js";
import { PermanentDeliveryError, type Inbound } from "../src/types.js";

const room = "!room:example.org", bot = "@bot:example.org", owner = "@owner:example.org";
async function fixture(encrypted = false, limit = 1024) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hayate-media-"));
  await mkdir(path.join(dir, "matrix-crypto"));
  const got: Inbound[] = [], calls: Array<{ url: URL; init: RequestInit }> = [], sent: any[] = [];
  let downloaded = Buffer.from("test image"), descriptor: any;
  const ch = new MatrixChannel({ homeserver: "https://hs.example", accessToken: "secret", userId: bot, e2ee: false,
    allowedUsers: [owner], allowAllUsers: false, allowedRooms: [], freeRooms: [], optionalReplyRooms: [],
    requireMention: true, autoThread: true, dmAutoThread: false, processNotices: false, approvers: [],
    batchDelayMs: 600, syncStateFile: path.join(dir, "sync.json"), mediaMaxBytes: limit,
    fetch: (async (url: any, init: RequestInit) => {
      const u = new URL(url); calls.push({ url: u, init });
      assert.equal(u.origin, "https://hs.example");
      assert.equal((init.headers as any).authorization, "Bearer secret");
      if (u.pathname.includes("/media/download/")) return new Response(new Uint8Array(downloaded));
      if (u.pathname.endsWith("/upload")) { downloaded = Buffer.from(init.body as any); return Response.json({ content_uri: "mxc://remote.example/id" }); }
      if (u.pathname.endsWith("/state/m.room.encryption")) return encrypted ? Response.json({ algorithm: "m.megolm.v1.aes-sha2" }) : new Response("{}", { status: 404 });
      if (u.pathname.endsWith("/joined_members")) return Response.json({ joined: { [bot]: {}, [owner]: {} } });
      if (u.pathname.includes("/send/")) { const c = JSON.parse(String(init.body)); sent.push(c); descriptor = c.file; return Response.json({ event_id: "$sent" }); }
      return Response.json({});
    }) as typeof fetch,
  });
  (ch as any).userId = bot;
  (ch as any).deliver = async (input: Inbound) => { got.push(input); };
  // Isolate the attachment encryption from Olm/Megolm (covered by matrix-e2ee-channel.test.ts).
  if (encrypted) (ch as any).crypto = { encrypt: async (_room: string, _type: string, content: any) => content };
  const event = (content: any, sender = owner) => ({ type: "m.room.message", event_id: "$media", sender, content });
  const receive = async (content: any, sender = owner) => {
    await (ch as any).onEvent(room, event(content, sender), encrypted);
    assert.equal(await (ch as any).recovery.settle(), true);
  };
  return { ch, dir, got, calls, sent, receive, get descriptor() { return descriptor; }, setData(data: Buffer) { downloaded = data; } };
}

test("Matrix downloads authorized files durably, sanitizes names and bypasses text batching", async () => {
  const f = await fixture();
  await f.receive({ msgtype: "m.image", body: "../../photo.png", url: "mxc://remote.example/id", info: { mimetype: "image/png" } });
  assert.equal(f.got.length, 1);
  const file = JSON.parse(f.got[0].text.match(/untrusted\): (.*)\]/)![1]).path;
  assert.equal(await readFile(file, "utf8"), "test image");
  assert.equal(path.dirname(file), path.join(f.dir, "matrix-media"));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.match(f.got[0].text, /^Matrix attachment:/);
  assert.equal(f.calls.find(c => c.url.pathname.includes("/media/download/"))!.init.redirect, "error");
  await f.receive({ msgtype: "m.file", body: "photo.png", url: "mxc://remote.example/id" });
  assert.equal(f.got.length, 2);
  await f.receive({ msgtype: "m.file", body: "/pause", url: "mxc://remote.example/id" });
  assert.ok(!f.got.at(-1)!.text.startsWith("/"), "attachment labels cannot execute slash commands");
});

test("Matrix media does not bypass sender/room permissions or allow arbitrary download URLs", async () => {
  const f = await fixture();
  await f.receive({ msgtype: "m.file", body: "file", url: "mxc://remote.example/id" }, "@stranger:example.org");
  assert.equal(f.got.length, 0);
  assert.ok(!f.calls.some(c => c.url.pathname.includes("/media/download/")));
  await assert.rejects(f.receive({ msgtype: "m.file", body: "file", url: "https://attacker.example/file" }), /Invalid Matrix media URI/);
  (f.ch as any).o.admissionRooms = [];
  await f.receive({ msgtype: "m.file", body: "file", url: "mxc://remote.example/id" });
  await assert.rejects(f.ch.send({ channel: "matrix", target: room }, `MEDIA:${f.dir}/secret`), PermanentDeliveryError);
  assert.ok(!f.calls.some(c => c.url.pathname.endsWith("/upload")));
});

test("Matrix bounds streamed downloads and local uploads", async () => {
  const f = await fixture(false, 4);
  await assert.rejects(f.receive({ msgtype: "m.file", body: "big", url: "mxc://remote.example/id" }), /size limit/);
  const file = path.join(f.dir, "big.txt"); await writeFile(file, "12345");
  await assert.rejects(f.ch.send({ channel: "matrix", target: room }, `MEDIA:${file}`), PermanentDeliveryError);
  assert.ok(!f.calls.some(c => c.url.pathname.endsWith("/upload")));
  const options = matrixOptionsFromEnv({ MATRIX_HOMESERVER: "https://hs", MATRIX_ACCESS_TOKEN: "t", MATRIX_MEDIA_MAX_BYTES: "NaN" }, f.dir)!;
  assert.throws(() => new MatrixChannel(options), /Invalid MATRIX_MEDIA_MAX_BYTES/);
});

test("Matrix uploads images/files in threads with stable delivery transactions", async () => {
  const f = await fixture();
  const file = path.join(f.dir, "photo.png"); await writeFile(file, "image bytes");
  const to = { channel: "matrix", target: room, thread: "$thread" };
  await f.ch.send(to, `MEDIA:${file}`, { deliveryId: "delivery", progressId: "progress" });
  await f.ch.send(to, `MEDIA:${file}`, { deliveryId: "delivery" });
  assert.equal(f.sent[0].msgtype, "m.image");
  assert.equal(f.sent[0].url, "mxc://remote.example/id");
  assert.equal(f.sent[0]["m.relates_to"].event_id, "$thread");
  assert.equal(f.sent[0].info.mimetype, "image/png");
  const sends = f.calls.filter(c => c.url.pathname.includes("/send/"));
  assert.equal(sends[0].url.pathname, sends[1].url.pathname);
  await f.ch.send(to, `MEDIA:${file}`, { presentation: "progress" });
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith("/upload")).length, 2, "progress never uploads files");
  await f.ch.send(to, `Example:\n\`\`\`text\nMEDIA:${file}\n\`\`\``);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith("/upload")).length, 2, "quoted protocol examples never upload");
});

test("Matrix encrypted attachment upload/download roundtrip and tamper detection", async () => {
  const f = await fixture(true);
  const file = path.join(f.dir, "private.txt"); await writeFile(file, "private bytes");
  await f.ch.send({ channel: "matrix", target: room }, `MEDIA:${file}`, { deliveryId: "encrypted" });
  assert.equal(f.sent[0].url, undefined);
  assert.equal(f.descriptor.v, "v2");
  const upload = f.calls.find(c => c.url.pathname.endsWith("/upload"))!;
  assert.equal(upload.url.search, "", "encrypted filenames are not disclosed to the media server");
  assert.notEqual(Buffer.from(upload.init.body as any).toString(), "private bytes");
  await f.receive({ msgtype: "m.file", body: "private.txt", file: f.descriptor });
  const local = JSON.parse(f.got[0].text.match(/untrusted\): (.*)\]/)![1]).path;
  assert.equal(await readFile(local, "utf8"), "private bytes");
  f.setData(Buffer.from("tampered"));
  await assert.rejects(f.receive({ msgtype: "m.file", body: "private.txt", file: f.descriptor }), /integrity check failed/);
  (f.ch as any).crypto = undefined;
  const uploads = f.calls.filter(c => c.url.pathname.endsWith("/upload")).length;
  await assert.rejects(f.ch.send({ channel: "matrix", target: room }, `MEDIA:${file}`), /refusing plaintext media/);
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith("/upload")).length, uploads);
});
