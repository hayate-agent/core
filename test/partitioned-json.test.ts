import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PartitionedJson } from "../src/partitioned-json.js";
import { writeFileDurable } from "../src/durable.js";
import { StateStore, type PersistedState } from "../src/state.js";
import { ExecutionStore } from "../src/execution.js";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "partition-json-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return path.join(dir, "state.json");
}
const arrays = { sessions: 1, pending: 1, outbox: 1, seen: 256 };
const snapshot = (value = "before"): PersistedState => ({ version: 1, paused: false, busyMode: "queue",
  sessions: [{ key: "a/../../sensitive", stopPending: true, resetPending: true, resetSources: ["user"],
    sourceOwner: "owner", heldRecoveryInputs: [{ sessionKey: "a", text: "unknown effect", source: "channel" }] },
    { key: "b", statusDelivered: { status: value } }],
  pending: [{ id: "accepted", sessionKey: "a", text: "pending exact bytes\n\u0000", source: "channel" }],
  outbox: [{ id: "delivery", sessionKey: "a", to: { channel: "matrix", target: "room" }, text: "finished, never rerun" }],
  seen: ["accepted", "old-receipt"],
});

test("legacy migration is byte-exact, restartable and not itself an authority/effect transition", async t => {
  const file = await fixture(t), original = snapshot();
  const legacy = JSON.stringify(original, null, 3) + "\n";
  await writeFile(file, legacy);
  const store = new StateStore(file);
  assert.deepEqual(await store.load(), original);
  assert.equal(await readFile(file, "utf8"), legacy, "read alone does not migrate");
  await store.save(original);
  assert.equal(await readFile(`${file}.legacy-v1`, "utf8"), legacy);
  assert.deepEqual(await new StateStore(file).load(), original);
  const index = JSON.parse(await readFile(file, "utf8"));
  assert.equal(index.format, "hayate-partitioned-json");
  assert.equal(index.document.sessions, undefined);
  assert.equal(index.document.pending, undefined);
  assert.equal(index.document.outbox, undefined);
  assert.equal(index.document.seen, undefined);
  assert.equal(index.collections.sessions[0].key, "a/../../sensitive");
  for (const entry of await readdir(`${file}.parts`)) {
    assert.match(entry, /^[a-f0-9]{64}\.json$/);
    assert.equal((await stat(path.join(`${file}.parts`, entry))).mode & 0o777, 0o600);
  }
  const before = await readFile(file, "utf8");
  await store.save(original);
  assert.equal(await readFile(file, "utf8"), before);
  // No input dedupe/outbox/idempotency data moved to a second independently
  // authoritative file: the exact same arrays return to existing host restore.
  assert.deepEqual((await store.load())?.seen, original.seen);
  assert.deepEqual((await store.load())?.outbox, original.outbox);
});

test("save without prior load still preserves the legacy file before replacing it", async t => {
  const file = await fixture(t), legacy = JSON.stringify(snapshot());
  await writeFile(file, legacy);
  await new StateStore(file).save(snapshot("changed"));
  assert.equal(await readFile(`${file}.legacy-v1`, "utf8"), legacy);
  assert.deepEqual(await new StateStore(file).load(), snapshot("changed"));
});

for (const migration of [false, true]) {
  for (const failAt of [1, 2, 3]) {
    test(`failure ${failAt} of payload/payload/index keeps prior complete authority (legacy=${migration})`, async t => {
      const file = await fixture(t), original = snapshot();
      if (migration) await writeFile(file, JSON.stringify(original));
      else await new StateStore(file).save(original);
      let writes = 0, fail = true;
      const disk = new PartitionedJson(file, arrays, async (...args) => {
        if (fail && ++writes === failAt) throw Error("injected write failure");
        await writeFileDurable(...args);
      });
      await disk.load();
      // In legacy migration every shard is initially new; failAt 1/2/3 still
      // tests prefix failure before publication. Partition update has 2 changed
      // payloads followed by the single index commit.
      const changed = snapshot("after"); changed.pending![0]!.text = "new pending";
      await assert.rejects(disk.save(changed as unknown as Record<string, unknown>), /injected/);
      assert.deepEqual(await new StateStore(file).load(), original);
      fail = false;
      await disk.save(changed as unknown as Record<string, unknown>);
      assert.deepEqual(await new StateStore(file).load(), changed);
      if (migration) assert.equal(await readFile(`${file}.legacy-v1`, "utf8"), JSON.stringify(original));
    });
  }
}

test("failure of migration index publication after all payloads and legacy backup is restartable", async t => {
  const file = await fixture(t), original = snapshot();
  const legacy = JSON.stringify(original); await writeFile(file, legacy);
  const disk = new PartitionedJson(file, arrays, async (target, ...args) => {
    if (target === file) throw Error("index not published");
    await writeFileDurable(target, ...args);
  });
  await disk.load();
  await assert.rejects(disk.save(snapshot("after") as unknown as Record<string, unknown>), /not published/);
  assert.equal(await readFile(file, "utf8"), legacy);
  assert.equal(await readFile(`${file}.legacy-v1`, "utf8"), legacy);
  const fresh = new StateStore(file); await fresh.load(); await fresh.save(snapshot("after"));
  assert.deepEqual(await new StateStore(file).load(), snapshot("after"));
});

test("post-rename uncertain failure fences the old writer; restart sees a complete new generation", async t => {
  const file = await fixture(t); await new StateStore(file).save(snapshot());
  const disk = new PartitionedJson(file, arrays, async (target, ...args) => {
    await writeFileDurable(target, ...args);
    if (target === file) throw Error("directory sync outcome unknown");
  });
  await disk.load();
  await assert.rejects(disk.save(snapshot("new") as unknown as Record<string, unknown>), /unknown/);
  await assert.rejects(disk.save(snapshot() as unknown as Record<string, unknown>), /restart required/);
  assert.deepEqual(await new StateStore(file).load(), snapshot("new"));
});

test("unreferenced payloads are ignored; missing/corrupt referenced shards never fall back to legacy", async t => {
  const file = await fixture(t); await writeFile(file, JSON.stringify(snapshot()));
  await new StateStore(file).save(snapshot());
  await writeFile(path.join(`${file}.parts`, "unreferenced.json"), "invalid json");
  assert.deepEqual(await new StateStore(file).load(), snapshot());
  const index = JSON.parse(await readFile(file, "utf8"));
  const shard = path.join(`${file}.parts`, `${index.collections.sessions[0].hash}.json`);
  const original = await readFile(shard, "utf8");
  await writeFile(shard, "{}\n");
  await assert.rejects(new StateStore(file).load(), /checksum mismatch/);
  await writeFile(shard, original); await rm(shard);
  await assert.rejects(new StateStore(file).load(), /Missing\/unreadable partition/);
});

test("session isolation: an update rewrites only that session payload and the index", async t => {
  const file = await fixture(t); const writes: string[] = [];
  const disk = new PartitionedJson(file, arrays, async (target, ...args) => { writes.push(target); await writeFileDurable(target, ...args); });
  await disk.save(snapshot() as unknown as Record<string, unknown>); writes.length = 0;
  const old = JSON.parse(await readFile(file, "utf8"));
  await disk.save(snapshot("after") as unknown as Record<string, unknown>);
  const next = JSON.parse(await readFile(file, "utf8"));
  assert.equal(writes.length, 2);
  assert.equal(old.collections.sessions[0].hash, next.collections.sessions[0].hash);
  assert.notEqual(old.collections.sessions[1].hash, next.collections.sessions[1].hash);
  for (const name of ["pending", "outbox", "seen"]) assert.deepEqual(old.collections[name], next.collections[name]);
});

test("serialized overlapping session captures retain every barrier without losing independent updates", async t => {
  const file = await fixture(t), store = new StateStore(file), live = snapshot();
  const barriers = Array.from({ length: 30 }, (_, i) => store.capture(() => {
    live.sessions[i % 2]!.sourceOwner = `owner-${i}`;
    return live;
  }));
  await Promise.all(barriers);
  const reopened = await new StateStore(file).load();
  assert.equal(reopened?.sessions[0]?.sourceOwner, "owner-28");
  assert.equal(reopened?.sessions[1]?.sourceOwner, "owner-29");
  assert.deepEqual(reopened?.pending, live.pending); assert.deepEqual(reopened?.outbox, live.outbox);
});

test("execution migration preserves unknown effects, budgets, task linkage, dedup and stops across restart", async t => {
  const file = await fixture(t), seed = new ExecutionStore(file); await seed.load();
  const a = await seed.submit("parent", "unsafe", "work", "direct", 1, { taskId: "mandate", expiresAt: 9999999999999 });
  const b = await seed.submit("other-parent", "other", "other work", "direct");
  const claim = await seed.claim(a.id); await seed.intent(a.id, claim.token!, "external-effect", "unsafe");
  await seed.control(a.id, "pause");
  await seed.beginTurn("turn", "session"); await seed.stopTurn("turn", "session");
  const original = { version: 1, executions: seed.list(), events: seed.events(), turns: [seed.turn("turn", "session")] };
  // Seed an actual old on-disk contract, including its token/effect checkpoint.
  const legacy = JSON.stringify(original); await writeFile(file, legacy);
  const store = new ExecutionStore(file); await store.load();
  await store.control(b.id, "pause"); // unrelated update triggers migration
  assert.equal(await readFile(`${file}.legacy-v1`, "utf8"), legacy);
  const reopened = new ExecutionStore(file); await reopened.load();
  assert.deepEqual(reopened.list("parent"), JSON.parse(JSON.stringify(original.executions.filter(x => x.parent === "parent"))));
  assert.equal(reopened.turn("turn", "session")?.stopped, true);
  assert.equal((await reopened.submit("parent", "unsafe", "work", "direct", 1, { taskId: "mandate", expiresAt: 9999999999999 })).id, a.id);
  await reopened.recover(new Map([["direct", { version: 1, replaySafe: false }]]), 2);
  assert.equal(reopened.list("parent")[0]?.status, "blocked");
  await assert.rejects(reopened.claim(a.id), /not claimable/);
  assert.equal(reopened.list("parent")[0]?.intent?.key, "external-effect");
});

test("execution transaction queue keeps simultaneous run updates, events and dedup receipts", async t => {
  const file = await fixture(t), store = new ExecutionStore(file); await store.load();
  const tasks = await Promise.all(Array.from({ length: 12 }, (_, i) => store.submit(`p${i}`, `r${i}`, "work", "direct")));
  await Promise.all(tasks.map(x => store.control(x.id, "pause")));
  const again = new ExecutionStore(file); await again.load();
  assert.equal(again.list().length, 12); assert.ok(again.list().every(x => x.status === "paused"));
  assert.equal(again.events().length, store.events().length);
  for (let i = 0; i < tasks.length; i++) assert.equal((await again.submit(`p${i}`, `r${i}`, "work", "direct")).id, tasks[i]!.id);
});
