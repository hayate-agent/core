import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalSessions } from "../src/local-sessions.js";

test("local sessions start fresh, survive restart and only resume explicitly within their workspace", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
  const a = path.join(home, "a"); const b = path.join(home, "b");
  await mkdir(a); await mkdir(b);
  const first = await LocalSessions.open(home, a);
  const other = await LocalSessions.open(home, b);
  const restarted = await LocalSessions.open(home, a);
  try {
    const one = await first.create("First conversation");
    await first.release();
    const two = await restarted.create();
    assert.notEqual(one.key, two.key);
    assert.equal(restarted.current?.id, two.id);
    assert.equal((await restarted.list()).length, 2);
    assert.deepEqual(await other.list(), []);
    await assert.rejects(other.resume(one.id), /not found/);
    await restarted.resume(one.id);
    assert.equal(restarted.current?.key, one.key);
    assert.equal((await restarted.list()).find((s) => s.id === one.id)?.title, "First conversation");
    assert.deepEqual(await restarted.history(one), []);
    await assert.rejects(other.resume("../../console_local"), /not found/);
  } finally { await first.release(); await other.release(); await restarted.release(); await rm(home, { recursive: true, force: true }); }
});

test("two terminals cannot resume the same session; failed switches retain the current session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
  const a = await LocalSessions.open(home, home); const b = await LocalSessions.open(home, home);
  try {
    const one = await a.create(); const two = await b.create();
    await assert.rejects(b.resume(one.id), /already open/);
    assert.equal(b.current?.id, two.id);
    await a.release();
    await b.resume(one.id);
    assert.equal(b.current?.id, one.id);
    await assert.rejects(a.resume(two.id), /already open/, "switching must retain ownership of background sessions");
  } finally { await a.release(); await b.release(); await rm(home, { recursive: true, force: true }); }
});

test("home ownership prevents concurrent processes from overwriting the shared ledger", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-home-lock-"));
  const a = await LocalSessions.open(home, home); const b = await LocalSessions.open(home, home);
  try {
    await a.acquireHome();
    await assert.rejects(b.acquireHome(), /already open/);
    await a.release();
    await b.acquireHome();
  } finally { await a.release(); await b.release(); await rm(home, { recursive: true, force: true }); }
});

test("resume displays only the active branch of its own Harness history; legacy data stays untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
  const store = await LocalSessions.open(home, home);
  try {
    const row = await store.create();
    const dir = path.join(home, "sessions", row.key); await mkdir(dir, { recursive: true });
    const legacy = path.join(home, "sessions", "console_local"); await mkdir(legacy);
    await writeFile(path.join(legacy, "old.jsonl"), "legacy-private-data");
    const entries = [
      { type: "session", id: "root" },
      { id: "a", parentId: "root", message: { role: "user", content: [{ type: "text", text: "hello" }] } },
      { id: "abandoned", parentId: "a", message: { role: "assistant", content: "wrong branch" } },
      { id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "answer" }] } },
    ];
    await writeFile(path.join(dir, "2026.jsonl"), entries.map((e) => JSON.stringify(e)).join("\n"));
    assert.deepEqual(await store.history(row), ["You: hello", "Agent: answer"]);
    assert.equal(await readFile(path.join(legacy, "old.jsonl"), "utf8"), "legacy-private-data");
    assert.equal((await store.list()).length, 1);
  } finally { await store.release(); await rm(home, { recursive: true, force: true }); }
});
