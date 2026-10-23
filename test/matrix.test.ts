import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { chunks, fitChunks, MatrixChannel, type MatrixOptions, matrixOptionsFromEnv } from "../src/channels/matrix.js";
import type { Inbound } from "../src/types.js";

const BOT = "@agent:example.org";
const OWNER = "@owner:example.org";
const DM = "!dm:example.org";
const ROOM = "!team:example.org";
const FREE = "!free:example.org";

/** Minimal fake homeserver: queued /sync responses, recorded requests. */
function fakeServer(members: Record<string, number>) {
  const syncs: any[] = [];
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const p = u.pathname.replace("/_matrix/client/v3", "");
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path: p, body });
    let out: any = {};
    if (p === "/account/whoami") out = { user_id: BOT };
    else if (p === "/sync") out = syncs.shift() ?? { next_batch: `b${++n}` };
    else if (p.endsWith("/joined_members")) {
      const room = decodeURIComponent(p.split("/")[2]);
      out = { joined: Object.fromEntries(Array.from({ length: members[room] ?? 3 }, (_, i) => [`@u${i}:x`, {}])) };
    } else if (p.includes("/send/")) out = { event_id: `$sent${calls.length}` };
    return new Response(JSON.stringify(out), { status: 200 });
  }) as typeof fetch;
  return { syncs, calls, fetch: f };
}

let evN = 0;
function msgEvent(sender: string, body: string, extra: Record<string, any> = {}) {
  return { type: "m.room.message", event_id: `$e${++evN}`, sender, content: { msgtype: "m.text", body, ...extra } };
}
function syncWith(room: string, ...events: any[]) {
  return { next_batch: `n${++evN}`, rooms: { join: { [room]: { timeline: { events } } } } };
}

async function setup(over: Partial<MatrixOptions> = {}, firstSync?: any) {
  const server = fakeServer({ [DM]: 2, [ROOM]: 5, [FREE]: 4 });
  if (firstSync) server.syncs.push(firstSync);
  const dir = over.syncStateFile ? "" : await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const ch = new MatrixChannel({
    homeserver: "https://hs.example",
    accessToken: "tok",
    displayName: "Example Agent",
    allowedUsers: [OWNER, "@teammate:example.org"],
    allowAllUsers: false,
    allowedRooms: [],
    freeRooms: [FREE],
    optionalReplyRooms: [],
    requireMention: true,
    autoThread: true,
    dmAutoThread: false,
    processNotices: false,
    approvers: [OWNER],
    batchDelayMs: 0,
    syncStateFile: over.syncStateFile ?? path.join(dir, "sync.json"),
    fetch: server.fetch,
    log: () => {},
    ...over,
  });
  const got: Inbound[] = [];
  await ch.start(async (i) => {
    got.push(i);
  });
  await ch.stop(); // stop the background loop; tests drive syncOnce()
  (ch as any).abort = new AbortController();
  return { ch, server, got };
}

test("env mapping follows Hermes names and defaults", () => {
  const o = matrixOptionsFromEnv(
    {
      MATRIX_HOMESERVER: "https://matrix.example.org/",
      MATRIX_ACCESS_TOKEN: "x",
      MATRIX_ALLOWED_USERS: `${OWNER}, @teammate:example.org`,
      MATRIX_FREE_RESPONSE_ROOMS: FREE,
      MATRIX_HOME_ROOM: DM,
      MATRIX_TEXT_BATCH_DELAY_SECONDS: "1.5",
    },
    "/h",
  )!;
  assert.equal(o.homeserver, "https://matrix.example.org");
  assert.deepEqual(o.allowedUsers, [OWNER, "@teammate:example.org"]);
  assert.equal(o.requireMention, true);
  assert.equal(o.autoThread, true);
  assert.equal(o.batchDelayMs, 1500);
  assert.equal(o.homeRoom, DM);
  assert.equal(matrixOptionsFromEnv({ MATRIX_HOMESERVER: "x" }, "/h"), undefined);
});

test("DM: always answered, no thread, plain text", async () => {
  const { ch, server, got } = await setup();
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "Wie ist der Stand?")));
  await ch.syncOnce();
  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { id: got[0].id, sessionKey: `matrix:${DM}`, text: "Wie ist der Stand?", source: "channel", sender: OWNER, replyTo: { channel: "matrix", target: DM, thread: undefined }, replyOptional: undefined });
});

test("group room: ignored without mention, threaded with mention, then thread needs no mention", async () => {
  const { ch, server, got } = await setup();
  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, "random chatter")));
  await ch.syncOnce();
  assert.equal(got.length, 0);

  const mention = msgEvent(OWNER, `${BOT}: bitte deployen`, { "m.mentions": { user_ids: [BOT] } });
  server.syncs.push(syncWith(ROOM, mention));
  await ch.syncOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].text, `[${OWNER}] bitte deployen`);
  assert.equal(got[0].replyTo?.thread, mention.event_id);
  assert.equal(got[0].sessionKey, `matrix:${ROOM}:${mention.event_id}`);

  // before the bot answered, the thread still needs a mention
  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, "noch da?", { "m.relates_to": { rel_type: "m.thread", event_id: mention.event_id } })));
  await ch.syncOnce();
  assert.equal(got.length, 1);
  await ch.send(got[0].replyTo!, "mache ich");

  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, "und danach testen", { "m.relates_to": { rel_type: "m.thread", event_id: mention.event_id } })));
  await ch.syncOnce();
  assert.equal(got.length, 2);
  assert.equal(got[1].sessionKey, got[0].sessionKey);
});

test("display-name mention and slash commands pass the gate", async () => {
  const { ch, server, got } = await setup();
  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, "Example Agent, kurzer Status?"), msgEvent(OWNER, "/status")));
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.text), [`[${OWNER}] kurzer Status?`, "/status"]);
});

test("free room: unaddressed messages arrive as reply-optional, unthreaded", async () => {
  const { ch, server, got } = await setup();
  server.syncs.push(syncWith(FREE, msgEvent("@teammate:example.org", "Build ist rot")));
  await ch.syncOnce();
  assert.equal(got[0].replyOptional, true);
  assert.equal(got[0].replyTo?.thread, undefined);
});

test("strangers, own messages, notices and edits are ignored", async () => {
  const { ch, server, got } = await setup();
  server.syncs.push(
    syncWith(
      DM,
      msgEvent("@evil:x", "hi"),
      msgEvent(BOT, "my own"),
      { ...msgEvent(OWNER, "notice"), content: { msgtype: "m.notice", body: "n" } },
      msgEvent(OWNER, "* fix", { "m.relates_to": { rel_type: "m.replace", event_id: "$x" } }),
    ),
  );
  await ch.syncOnce();
  assert.equal(got.length, 0);
});

test("allowed rooms whitelist applies to groups only", async () => {
  const { ch, server, got } = await setup({ allowedRooms: [FREE] });
  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, `${BOT} hi`)));
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "hi")));
  await ch.syncOnce();
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.replyTo?.target), [DM]);
});

test("rapid messages of one sender are batched into one turn", async () => {
  const { ch, server, got } = await setup({ batchDelayMs: 20 });
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "erstens"), msgEvent(OWNER, "zweitens")));
  await ch.syncOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "erstens\nzweitens");
});

test("rapid top-level mentions in a group (auto-thread) merge into one thread turn", async () => {
  const { ch, server, got } = await setup({ batchDelayMs: 20 });
  const a = msgEvent(OWNER, "Example Agent: erstens");
  const b = msgEvent(OWNER, "Example Agent: zweitens");
  server.syncs.push(syncWith(ROOM, a, b));
  await ch.syncOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.length, 1);
  assert.deepEqual(got[0].parts?.map((p) => p.id), [a.event_id, b.event_id]);
  assert.equal(got[0].replyTo?.thread, a.event_id);
});

test("sustained rapid messages are still handed off (batch is bounded)", async () => {
  const { ch, server, got } = await setup({ batchDelayMs: 10_000 });
  const events = Array.from({ length: 45 }, (_, i) => msgEvent(OWNER, `teil ${i}`));
  server.syncs.push(syncWith(DM, ...events));
  await ch.syncOnce();
  assert.equal(got.length, 2, "two full batches handed off without waiting for the debounce");
  assert.equal(got[0].parts?.length, 20);
  (ch as any).batches.forEach((b: any) => clearTimeout(b.timer));
});

test("send: markdown → HTML, thread relation, approval prompt resolved by approver reaction only", async () => {
  const { ch, server, got } = await setup();
  await ch.send({ channel: "matrix", target: ROOM, thread: "$root" }, "**fertig**", { approvalId: "ab12" });
  const sent = server.calls.find((c) => c.path.includes("/send/m.room.message/"))!;
  assert.equal(sent.body.formatted_body, "<p><strong>fertig</strong></p>");
  assert.equal(sent.body["m.relates_to"].rel_type, "m.thread");
  const promptId = `$sent${server.calls.indexOf(sent) + 1}`;

  const reaction = (sender: string, key: string) => ({ type: "m.reaction", event_id: `$r${++evN}`, sender, content: { "m.relates_to": { rel_type: "m.annotation", event_id: promptId, key } } });
  server.syncs.push(syncWith(ROOM, reaction("@teammate:example.org", "✅")));
  await ch.syncOnce();
  assert.equal(got.length, 0, "peer agent's automatic ✅ must not approve");
  server.syncs.push(syncWith(ROOM, reaction(OWNER, "✅️")));
  await ch.syncOnce();
  assert.equal(got[0].text, "/approve ab12");
  assert.equal(got[0].sender, OWNER);
});

test("approval reactions fail closed when no remote approvers are configured", async () => {
  const { ch, server, got } = await setup({ approvers: [] });
  await ch.send({ channel: "matrix", target: ROOM }, "approve?", { approvalId: "ab12" });
  const sent = server.calls.find((c) => c.path.includes("/send/m.room.message/"))!;
  const promptId = `$sent${server.calls.indexOf(sent) + 1}`;
  server.syncs.push(
    syncWith(ROOM, {
      type: "m.reaction",
      event_id: `$r${++evN}`,
      sender: OWNER,
      content: { "m.relates_to": { rel_type: "m.annotation", event_id: promptId, key: "✅" } },
    }),
  );
  await ch.syncOnce();
  assert.equal(got.length, 0);
});

test("invites from allowed users are accepted", async () => {
  const { ch, server } = await setup();
  server.syncs.push({ next_batch: "i1", rooms: { invite: { "!new:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: OWNER }] } }, "!spam:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: "@evil:x" }] } } } } });
  await ch.syncOnce();
  const joins = server.calls.filter((c) => c.path.endsWith("/join")).map((c) => decodeURIComponent(c.path.split("/")[2]));
  assert.deepEqual(joins, ["!new:x"]);
});

test("a batch flushed during invite processing is settled before the cursor is committed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const { ch, server } = await setup({ syncStateFile: file, batchDelayMs: 5 });
  const before = await readFile(file, "utf8");
  // acceptance of the batched message fails
  (ch as any).deliver = async () => {
    throw new Error("disk full");
  };
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/join")) await new Promise((r) => setTimeout(r, 30)); // batch timer fires meanwhile
    return realFetch(url, init);
  };
  server.syncs.push({
    next_batch: "race",
    rooms: {
      join: { [DM]: { timeline: { events: [msgEvent(OWNER, "batched")] } } },
      invite: { "!new:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: OWNER }] } } },
    },
  });
  await assert.rejects(ch.syncOnce(), /will retry/);
  assert.equal(await readFile(file, "utf8"), before, "cursor must not cover a failed hand-off");
});

test("a permanently failed invite does not block joined-room messages", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const { ch, server, got } = await setup({ syncStateFile: path.join(dir, "sync.json") });
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/join")) return new Response("{}", { status: 403 });
    return realFetch(url, init);
  };
  server.syncs.push({
    next_batch: "invite-failed",
    rooms: {
      invite: { "!forbidden:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: OWNER }] } } },
      join: { [DM]: { timeline: { events: [msgEvent(OWNER, "still process me")] } } },
    },
  });
  await ch.syncOnce();
  assert.deepEqual(got.map((input) => input.text), ["still process me"]);
  const dead = await readFile(path.join(dir, "matrix-deadletter.jsonl"), "utf8");
  assert.match(dead, /invite:!forbidden:x/);
});

test("an invite remains checkpointed when permanent-failure parking fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const { ch, server } = await setup({ syncStateFile: file });
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/join")) return new Response("{}", { status: 403 });
    return realFetch(url, init);
  };
  (ch as any).recovery.deadLetter = async () => {
    throw new Error("disk full");
  };
  server.syncs.push({
    next_batch: "invite-unparked",
    rooms: { invite: { "!keep:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: OWNER }] } } } },
  });
  await ch.syncOnce();
  assert.ok(JSON.parse(await readFile(file, "utf8")).pendingInvites["!keep:x"]);
});

test("a transiently failed invite is checkpointed and retried after restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const first = await setup({ syncStateFile: file });
  const realFetch = (first.ch as any).fetch;
  (first.ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.endsWith("/join")) return new Response("{}", { status: 502 });
    return realFetch(url, init);
  };
  first.server.syncs.push({
    next_batch: "invite-pending",
    rooms: { invite: { "!later:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: OWNER }] } } } },
  });
  await first.ch.syncOnce();
  assert.ok(JSON.parse(await readFile(file, "utf8")).pendingInvites["!later:x"]);

  const second = await setup({ syncStateFile: file });
  assert.ok(second.server.calls.some((call) => call.path === `/rooms/${encodeURIComponent("!later:x")}/join`));
});

test("first start: history skipped, pending invites accepted", async () => {
  const first = {
    next_batch: "start",
    rooms: {
      join: { [DM]: { timeline: { events: [msgEvent(OWNER, "old message")] } } },
      invite: { "!early:x": { invite_state: { events: [{ type: "m.room.member", state_key: BOT, sender: OWNER }] } } },
    },
  };
  const { server, got } = await setup({}, first);
  assert.equal(got.length, 0);
  assert.ok(server.calls.some((c) => c.path === `/rooms/${encodeURIComponent("!early:x")}/join`));
});

test("sync token is not persisted past batched messages; stop hands them over", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const { ch, server, got } = await setup({ batchDelayMs: 10_000, syncStateFile: file });
  const before = await readFile(file, "utf8");
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "pending")));
  await ch.syncOnce();
  assert.equal(await readFile(file, "utf8"), before, "token must not advance while batch pending");
  await ch.stop();
  assert.deepEqual(got.map((g) => g.text), ["pending"]);
  assert.notEqual(await readFile(file, "utf8"), before);
});

test("bot threads survive a restart", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const a = await setup({ syncStateFile: file });
  const mention = msgEvent(OWNER, `${BOT} hallo`, { "m.mentions": { user_ids: [BOT] } });
  a.server.syncs.push(syncWith(ROOM, mention));
  await a.ch.syncOnce();
  await a.ch.send(a.got[0].replyTo!, "hallo zurück");
  a.server.syncs.push(syncWith(DM)); // next sync persists cursor + threads
  await a.ch.syncOnce();
  const b = await setup({ syncStateFile: file });
  b.server.syncs.push(syncWith(ROOM, msgEvent(OWNER, "weiter", { "m.relates_to": { rel_type: "m.thread", event_id: mention.event_id } })));
  await b.ch.syncOnce();
  assert.equal(b.got.length, 1);
});

test("cursor does not advance when the harness refuses an input; redelivered next sync", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const { ch, server } = await setup({ syncStateFile: file });
  const accepted: string[] = [];
  let fail = true;
  (ch as any).deliver = async (i: Inbound) => {
    if (fail) throw new Error("disk full");
    accepted.push(i.text);
  };
  const before = JSON.parse(await readFile(file, "utf8")).since;
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "wichtig")));
  await assert.rejects(ch.syncOnce(), /not accepted/);
  assert.equal(JSON.parse(await readFile(file, "utf8")).since, before);
  // next /sync uses the old cursor again
  fail = false;
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "wichtig")));
  await ch.syncOnce();
  const syncCalls = server.calls.filter((c) => c.path === "/sync");
  assert.equal(accepted.length, 1);
  assert.ok(syncCalls.length >= 2);
});

test("transient event failure retries from the durable cursor, poison event is skipped", async () => {
  const { ch, server, got } = await setup();
  const realFetch = (ch as any).fetch;
  let failMembers = 1;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.includes("/joined_members") && failMembers-- > 0) return new Response("{}", { status: 502 });
    return realFetch(url, init);
  };
  const ev = msgEvent(OWNER, "retry me");
  server.syncs.push(syncWith(DM, ev));
  await assert.rejects(ch.syncOnce(), /will retry/);
  assert.equal(got.length, 0);
  server.syncs.push(syncWith(DM, ev));
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.text), ["retry me"]);
});

test("permanent event failure goes to the dead-letter file after retries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const { ch, server } = await setup({ syncStateFile: path.join(dir, "sync.json") });
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.includes("/joined_members")) return new Response("{}", { status: 403 });
    return realFetch(url, init);
  };
  const poison = msgEvent(OWNER, "poison");
  for (let i = 0; i < 4; i++) {
    server.syncs.push(syncWith("!poison:x", poison));
    await assert.rejects(ch.syncOnce());
  }
  server.syncs.push(syncWith("!poison:x", poison));
  await ch.syncOnce(); // 5th attempt: parked, cursor advances
  const dead = (await readFile(path.join(dir, "matrix-deadletter.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(dead[0].event.event_id, poison.event_id);
});

test("deterministic event parsing failures are dead-lettered after bounded retries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const { ch, server } = await setup({ syncStateFile: path.join(dir, "sync.json") });
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.includes("/joined_members")) return new Response("not-json", { status: 200 });
    return realFetch(url, init);
  };
  const malformed = msgEvent(OWNER, "malformed room response");
  for (let attempt = 0; attempt < 5; attempt++) {
    server.syncs.push(syncWith("!malformed:x", malformed));
    if (attempt < 4) await assert.rejects(ch.syncOnce(), /will retry/);
    else await ch.syncOnce();
  }
  const dead = await readFile(path.join(dir, "matrix-deadletter.jsonl"), "utf8");
  assert.match(dead, new RegExp(malformed.event_id.replace("$", "\\$")));
});

test("transient (5xx) failures never skip the event", async () => {
  const { ch, server } = await setup();
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.includes("/joined_members")) return new Response("{}", { status: 503 });
    return realFetch(url, init);
  };
  const ev = msgEvent(OWNER, "keep");
  for (let i = 0; i < 8; i++) {
    server.syncs.push(syncWith("!flaky:x", ev));
    await assert.rejects(ch.syncOnce(), /will retry/);
  }
});

test("approver who is not an allowed user may still /approve", async () => {
  const { ch, server, got } = await setup({ approvers: ["@boss:x"] });
  server.syncs.push(syncWith(DM, msgEvent("@boss:x", "/approve ab12"), msgEvent("@boss:x", "hallo")));
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.text), ["/approve ab12"]);
});

test("limited timeline: skipped events are backfilled before the cursor advances", async () => {
  const { ch, server, got } = await setup();
  const old1 = msgEvent(OWNER, "gap one");
  const old2 = msgEvent(OWNER, "gap two");
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.includes("/messages?")) {
      const first = url.includes("from=p1");
      return new Response(JSON.stringify(first ? { chunk: [old2, old1], end: "e1" } : { chunk: [] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  server.syncs.push({ next_batch: "after", rooms: { join: { [DM]: { timeline: { limited: true, prev_batch: "p1", events: [msgEvent(OWNER, "newest")] } } } } });
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.text), ["gap one", "gap two", "newest"]);
});

test("backfill continues past an empty filtered page", async () => {
  const { ch, server, got } = await setup();
  const old = msgEvent(OWNER, "behind filler");
  const realFetch = (ch as any).fetch;
  (ch as any).fetch = async (url: string, init: RequestInit) => {
    if (url.includes("/messages?")) {
      if (url.includes("from=p1")) return new Response(JSON.stringify({ chunk: [], end: "e1" }), { status: 200 });
      if (url.includes("from=e1")) return new Response(JSON.stringify({ chunk: [old], end: "e2" }), { status: 200 });
      return new Response(JSON.stringify({ chunk: [], end: "e2" }), { status: 200 });
    }
    return realFetch(url, init);
  };
  server.syncs.push({ next_batch: "after", rooms: { join: { [DM]: { timeline: { limited: true, prev_batch: "p1", events: [msgEvent(OWNER, "newest")] } } } } });
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.text), ["behind filler", "newest"]);
});

test("retries of the same reply reuse transaction ids per chunk", async () => {
  const { ch, server } = await setup();
  const text = "a".repeat(12_000) + "b".repeat(10);
  await ch.send({ channel: "matrix", target: DM }, text, { deliveryId: "d1" });
  await ch.send({ channel: "matrix", target: DM }, text, { deliveryId: "d1" });
  const txns = server.calls.filter((c) => c.path.includes("/send/m.room.message/")).map((c) => c.path.split("/").at(-1));
  assert.deepEqual(txns, ["d1.0", "d1.1", "d1.0", "d1.1"]);
});

test("password login: token is persisted and reused; re-login only when rejected", async () => {
  const server = fakeServer({});
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  let logins = 0;
  let valid = new Set<string>();
  const f = (async (url: string, init: RequestInit) => {
    if (url.endsWith("/login")) {
      const tok = `t${++logins}`;
      valid.add(tok);
      return new Response(JSON.stringify({ access_token: tok, device_id: JSON.parse(String(init.body)).device_id }), { status: 200 });
    }
    const auth = String((init.headers as Record<string, string>)?.authorization ?? "");
    if (!valid.has(auth.replace("Bearer ", ""))) return new Response("{}", { status: 401 });
    return server.fetch(url, init);
  }) as typeof fetch;
  const run = async () => {
    const ch = new MatrixChannel({
      ...(matrixOptionsFromEnv({ MATRIX_HOMESERVER: "https://hs.example", MATRIX_USER_ID: BOT, MATRIX_PASSWORD: "pw" }, dir) as MatrixOptions),
      fetch: f,
      log: () => {},
    });
    await ch.start(async () => {});
    await ch.stop();
  };
  await run();
  await run();
  assert.equal(logins, 1, "second start reuses the saved token");
  valid = new Set(); // token revoked
  await run();
  assert.equal(logins, 2);
  // Token revoked while running: one renewal, request repeated with the new token.
  const live = new MatrixChannel({
    ...(matrixOptionsFromEnv({ MATRIX_HOMESERVER: "https://hs.example", MATRIX_USER_ID: BOT, MATRIX_PASSWORD: "pw" }, dir) as MatrixOptions),
    fetch: f,
    log: () => {},
  });
  await live.start(async () => {});
  await live.stop();
  (live as any).abort = new AbortController();
  valid = new Set();
  await Promise.all([live.send({ channel: "matrix", target: ROOM }, "a"), live.send({ channel: "matrix", target: ROOM }, "b")]);
  assert.equal(logins, 3, "single-flight renewal");
  const saved = JSON.parse(await readFile(path.join(dir, "matrix-session.json"), "utf8"));
  assert.equal(saved.accessToken, "t3");
  // Another homeserver never sees the saved token.
  const seenAuth: string[] = [];
  const other = new MatrixChannel({
    ...(matrixOptionsFromEnv({ MATRIX_HOMESERVER: "https://other.example", MATRIX_USER_ID: BOT, MATRIX_PASSWORD: "pw" }, dir) as MatrixOptions),
    fetch: (async (url: string, init: RequestInit) => {
      seenAuth.push(String((init.headers as Record<string, string>)?.authorization ?? ""));
      return f(url, init);
    }) as typeof fetch,
    log: () => {},
  });
  await assert.rejects(other.start(async () => {}), /belongs to/); // checkpoint of another server
  assert.ok(!seenAuth.includes("Bearer t2"));
});

test("redelivered event already buffered in a batch is kept once", async () => {
  const { ch, server, got } = await setup({ batchDelayMs: 20 });
  const a = msgEvent(OWNER, "eins");
  server.syncs.push(syncWith(DM, a));
  await ch.syncOnce();
  server.syncs.push(syncWith(DM, a)); // rewind/redelivery before the timer fired
  await ch.syncOnce();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(got.length, 1);
  assert.equal(got[0].text, "eins");
});

test("stop is bounded when a hand-off never settles; cursor stays", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  const { ch, server } = await setup({ syncStateFile: file, batchDelayMs: 50 });
  const before = await readFile(file, "utf8");
  (ch as any).deliver = () => new Promise<void>(() => {}); // hangs forever
  server.syncs.push(syncWith(DM, msgEvent(OWNER, "hang")));
  await ch.syncOnce();
  const t0 = Date.now();
  await ch.stop(100);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await readFile(file, "utf8"), before);
});

test("matrix pins handed-off ids until the cursor is committed", async () => {
  const server = fakeServer({ [DM]: 2 });
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const ch = new MatrixChannel({
    ...(matrixOptionsFromEnv({ MATRIX_HOMESERVER: "https://hs.example", MATRIX_ACCESS_TOKEN: "t", MATRIX_ALLOWED_USERS: OWNER, MATRIX_TEXT_BATCH_DELAY_SECONDS: "0" }, dir) as MatrixOptions),
    fetch: server.fetch,
    log: () => {},
  });
  const pinned = new Set<string>();
  await ch.start(async () => {}, { pin: (ids) => { for (const i of ids) pinned.add(i); }, unpin: (ids) => { for (const i of ids) pinned.delete(i); } });
  await ch.stop();
  (ch as any).abort = new AbortController();
  const ev = msgEvent(OWNER, "hi");
  let pinnedDuring = false;
  (ch as any).deliver = async () => { pinnedDuring = pinned.has(ev.event_id); };
  server.syncs.push(syncWith(DM, ev));
  await ch.syncOnce();
  assert.equal(pinnedDuring, true);
  assert.equal(pinned.has(ev.event_id), false); // committed → unpinned
});

test("mention-prefixed command in a group is dispatched as a command", async () => {
  const { ch, server, got } = await setup();
  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, "Example Agent: /pause")));
  server.syncs.push(syncWith(ROOM, msgEvent(OWNER, `${BOT} /status`)));
  await ch.syncOnce();
  await ch.syncOnce();
  assert.deepEqual(got.map((g) => g.text), ["/pause", "/status"]);
});

test("a mention only inside a reply quote does not activate the bot", async () => {
  const { ch, server, got } = await setup();
  const quoted = msgEvent(OWNER, `> <${BOT}> earlier answer\n\nirgendwas anderes`, {
    format: "org.matrix.custom.html",
    formatted_body: `<mx-reply><a href="https://matrix.to/#/${BOT}">${BOT}</a> earlier</mx-reply>irgendwas anderes`,
    "m.relates_to": { "m.in_reply_to": { event_id: "$old" } },
  });
  server.syncs.push(syncWith(ROOM, quoted));
  await ch.syncOnce();
  assert.equal(got.length, 0);
});

test("chunks never split surrogate pairs and fit the event byte budget", () => {
  const emoji = "😀".repeat(30);
  for (const c of chunks(emoji, 7)) assert.ok(!/[\uD800-\uDBFF]$/.test(c), c);
  const cjk = "**粗体**中文".repeat(2400); // ~14k code points, HTML roughly doubles the bytes
  const render = (c: string) => ({ body: c, formatted_body: c.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") });
  const parts = fitChunks(cjk, 12_000, render);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.ok(Buffer.byteLength(JSON.stringify(render(p))) <= 48_000);
  assert.equal(parts.join(""), cjk);
});

test("batched messages carry all event ids", async () => {
  const { ch, server, got } = await setup({ batchDelayMs: 10 });
  const a = msgEvent(OWNER, "eins");
  const b = msgEvent(OWNER, "zwei");
  server.syncs.push(syncWith(DM, a, b));
  await ch.syncOnce();
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(got[0].parts?.map((p) => p.id), [a.event_id, b.event_id]);
});

test("corrupt sync state fails loudly instead of skipping history", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vanillacore-harness-mx-"));
  const file = path.join(dir, "sync.json");
  await writeFile(file, "{broken");
  await assert.rejects(setup({ syncStateFile: file }));
});

test("configured Matrix user must match the authenticated access token", async () => {
  await assert.rejects(setup({ userId: "@other:example" }), /does not match authenticated user/);
});

test("chunks split long text on newlines", () => {
  const parts = chunks(`${"a".repeat(60)}\n${"b".repeat(60)}`, 100);
  assert.deepEqual(parts.map((p) => p.length), [60, 60]);
});
